/**
 * The EN 16931 business rules, as checks that run before an invoice is sent.
 *
 * Why this exists: from 2026 a rejected invoice is not an email that goes
 * unanswered, it is a document a tax platform refuses. Poland's KSeF clears
 * every invoice before it counts as delivered, Belgium requires Peppol, France
 * requires every business to be able to receive one. In a clearance model an
 * invoice that fails validation was never issued — so failing at your own desk,
 * with a message naming the rule, beats failing at theirs.
 *
 * Rule identifiers (BR-*, BR-CO-*, BR-S-*) are the standard's own, because they
 * are what the other side's rejection message will quote. The wording of each
 * check is this library's own; the normative text lives in EN 16931-1, which is
 * published by CEN and not reproduced here.
 */

import { Decimal } from "./decimal.ts";
import type { Invoice, VatBreakdown, VatCategory } from "./model.ts";

export type Severity = "fatal" | "warning";

export type Violation = {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  /** Where the problem is, e.g. "lines[2]" or "totals.taxInclusive". */
  readonly at?: string;
};

export type Result = {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
  readonly fatal: readonly Violation[];
  readonly warnings: readonly Violation[];
};

/** Categories that charge no VAT and therefore need a reason. */
const NEEDS_EXEMPTION_REASON: ReadonlySet<VatCategory> = new Set(["Z", "E", "AE", "K", "G", "O"]);

/** The rounding difference the rules tolerate on a total. */
const TOLERANCE = Decimal.parse("0.01");

export function validate(invoice: Invoice): Result {
  const violations: Violation[] = [];
  const fail = (rule: string, message: string, at?: string) =>
    violations.push({ rule, severity: "fatal", message, at });
  const warn = (rule: string, message: string, at?: string) =>
    violations.push({ rule, severity: "warning", message, at });

  // Presence rules. Dull, and the majority of real rejections.
  if (!invoice.id?.trim()) fail("BR-01", "the invoice has no number", "id");
  if (!isDate(invoice.issueDate)) fail("BR-02", "the issue date is missing or not a date", "issueDate");
  if (!invoice.typeCode?.trim()) fail("BR-03", "the invoice type code is missing", "typeCode");
  if (!isCurrency(invoice.currency)) {
    fail("BR-04", `"${invoice.currency}" is not a three-letter ISO 4217 currency`, "currency");
  }
  if (!invoice.seller?.name?.trim()) fail("BR-06", "the seller has no name", "seller.name");
  if (!invoice.buyer?.name?.trim()) fail("BR-07", "the buyer has no name", "buyer.name");
  if (!isCountry(invoice.seller?.address?.countryCode)) {
    fail("BR-09", "the seller's country is missing or not an ISO 3166-1 code", "seller.address.countryCode");
  }
  if (!isCountry(invoice.buyer?.address?.countryCode)) {
    fail("BR-11", "the buyer's country is missing or not an ISO 3166-1 code", "buyer.address.countryCode");
  }
  if (invoice.lines.length === 0) fail("BR-16", "the invoice has no lines", "lines");

  // A VAT identifier that does not start with its country is the single most
  // common reason a cross-border invoice bounces.
  const sellerVat = invoice.seller?.identification?.vatId;
  if (sellerVat && !/^[A-Z]{2}/.test(sellerVat)) {
    fail("BR-CO-09", `the seller's VAT identifier "${sellerVat}" does not start with a country code`,
      "seller.identification.vatId");
  }

  invoice.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    if (!line.id?.trim()) fail("BR-21", "the line has no identifier", at);
    if (!line.name?.trim()) fail("BR-25", "the line has no item name", at);
    if (!line.vatCategory) fail("BR-CO-04", "the line has no VAT category", at);

    // The check that catches a wrong invoice that looks right.
    try {
      const expected = Decimal.parse(line.netPrice).multiply(Decimal.parse(line.quantity)).round(2);
      const stated = Decimal.parse(line.netAmount);
      if (!stated.equalsWithin(expected, TOLERANCE)) {
        fail("BR-CO-16-LINE",
          `the line amount ${stated.toFixed()} does not match ${line.quantity} × ${line.netPrice} = ${expected.toFixed()}`,
          at);
      }
    } catch {
      fail("BR-CO-16-LINE", "the line quantity, price or amount is not a number", at);
    }
  });

  validateVat(invoice, fail, warn);
  validateTotals(invoice, fail);

  const fatal = violations.filter((v) => v.severity === "fatal");
  return {
    ok: fatal.length === 0,
    violations,
    fatal,
    warnings: violations.filter((v) => v.severity === "warning"),
  };
}

function validateVat(
  invoice: Invoice,
  fail: (rule: string, message: string, at?: string) => void,
  warn: (rule: string, message: string, at?: string) => void,
): void {
  if (invoice.vatBreakdown.length === 0) {
    fail("BR-CO-18", "the invoice has no VAT breakdown", "vatBreakdown");
    return;
  }

  invoice.vatBreakdown.forEach((group, index) => {
    const at = `vatBreakdown[${index}]`;

    // Charging nothing without saying why is the rejection that surprises
    // people: the amount is right, the reason is missing.
    if (NEEDS_EXEMPTION_REASON.has(group.category)) {
      if (!group.exemptionReason?.trim() && !group.exemptionReasonCode?.trim()) {
        fail(`BR-${group.category}-10`,
          `category ${group.category} charges no VAT but gives no exemption reason`, at);
      }
      const rate = safeDecimal(group.rate);
      if (rate && !rate.equals(Decimal.parse("0"))) {
        fail(`BR-${group.category}-05`, `category ${group.category} must carry a zero rate, not ${group.rate}`, at);
      }
    }

    if (group.category === "S") {
      const rate = safeDecimal(group.rate);
      if (!rate || rate.compare(Decimal.parse("0")) <= 0) {
        fail("BR-S-05", "a standard-rated group must carry a rate above zero", at);
        return;
      }
      const taxable = safeDecimal(group.taxableAmount);
      const tax = safeDecimal(group.taxAmount);
      if (!taxable || !tax) {
        fail("BR-S-08", "the taxable or tax amount is not a number", at);
        return;
      }
      const expected = taxable.percentOf(rate).round(2);
      if (!tax.equalsWithin(expected, TOLERANCE)) {
        fail("BR-S-09",
          `VAT of ${tax.toFixed()} does not match ${group.rate}% of ${taxable.toFixed()} = ${expected.toFixed()}`,
          at);
      }
    }
  });

  // Every category used on a line must appear in the breakdown, or the totals
  // will be right by accident and wrong by construction.
  const inBreakdown = new Set(invoice.vatBreakdown.map(key));
  for (const [index, line] of invoice.lines.entries()) {
    const wanted = key({ category: line.vatCategory, rate: line.vatRate } as VatBreakdown);
    if (!inBreakdown.has(wanted)) {
      fail("BR-CO-18",
        `no VAT breakdown group for category ${line.vatCategory} at ${line.vatRate}%`,
        `lines[${index}]`);
    }
  }

  if (invoice.vatBreakdown.length > new Set(invoice.vatBreakdown.map(key)).size) {
    warn("BR-CO-18", "two VAT breakdown groups share a category and rate; they should be one", "vatBreakdown");
  }
}

function validateTotals(invoice: Invoice, fail: (rule: string, message: string, at?: string) => void): void {
  const lineSum = invoice.lines.reduce(
    (total, line) => total.add(safeDecimal(line.netAmount) ?? Decimal.zero()),
    Decimal.zero(2),
  );
  const taxSum = invoice.vatBreakdown.reduce(
    (total, group) => total.add(safeDecimal(group.taxAmount) ?? Decimal.zero()),
    Decimal.zero(2),
  );

  const lineTotal = safeDecimal(invoice.totals?.lineTotal);
  const taxExclusive = safeDecimal(invoice.totals?.taxExclusive);
  const taxTotal = safeDecimal(invoice.totals?.taxTotal);
  const taxInclusive = safeDecimal(invoice.totals?.taxInclusive);
  const payable = safeDecimal(invoice.totals?.payable);

  if (!lineTotal || !taxExclusive || !taxTotal || !taxInclusive || !payable) {
    fail("BR-12", "one of the invoice totals is missing or not a number", "totals");
    return;
  }

  if (!lineTotal.equalsWithin(lineSum, TOLERANCE)) {
    fail("BR-CO-10", `the line total ${lineTotal.toFixed()} is not the sum of the lines, ${lineSum.toFixed()}`,
      "totals.lineTotal");
  }
  if (!taxExclusive.equalsWithin(lineTotal, TOLERANCE)) {
    fail("BR-CO-13", `the total without VAT ${taxExclusive.toFixed()} does not match the line total ${lineTotal.toFixed()}`,
      "totals.taxExclusive");
  }
  if (!taxTotal.equalsWithin(taxSum, TOLERANCE)) {
    fail("BR-CO-14", `the VAT total ${taxTotal.toFixed()} is not the sum of the VAT breakdown, ${taxSum.toFixed()}`,
      "totals.taxTotal");
  }
  const expectedInclusive = taxExclusive.add(taxTotal).round(2);
  if (!taxInclusive.equalsWithin(expectedInclusive, TOLERANCE)) {
    fail("BR-CO-15", `the total with VAT ${taxInclusive.toFixed()} does not equal ${taxExclusive.toFixed()} + ${taxTotal.toFixed()}`,
      "totals.taxInclusive");
  }
  if (!payable.equalsWithin(taxInclusive, TOLERANCE)) {
    fail("BR-CO-16", `the amount due ${payable.toFixed()} does not match the total with VAT ${taxInclusive.toFixed()}`,
      "totals.payable");
  }
}

function key(group: VatBreakdown): string {
  return `${group.category}@${safeDecimal(group.rate)?.toFixed(2) ?? group.rate}`;
}

function safeDecimal(value: string | undefined): Decimal | undefined {
  if (value === undefined) return undefined;
  try {
    return Decimal.parse(value);
  } catch {
    return undefined;
  }
}

function isDate(value: string | undefined): boolean {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isCurrency(value: string | undefined): boolean {
  return !!value && /^[A-Z]{3}$/.test(value);
}

function isCountry(value: string | undefined): boolean {
  return !!value && /^[A-Z]{2}$/.test(value);
}
