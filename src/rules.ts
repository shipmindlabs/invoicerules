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
import type { AllowanceCharge, Invoice, VatCategory } from "./model.ts";
import { TOLERANCE, groupKey, readTotals, reconcile } from "./vat.ts";

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

type Report = (rule: string, message: string, at?: string) => void;

/** Categories that charge no VAT and therefore need a reason. */
const NEEDS_EXEMPTION_REASON: ReadonlySet<VatCategory> = new Set(["Z", "E", "AE", "K", "G", "O"]);

const ZERO_RATE = Decimal.parse("0");

export function validate(invoice: Invoice): Result {
  const violations: Violation[] = [];
  const fail: Report = (rule, message, at) =>
    violations.push({ rule, severity: "fatal", message, at });
  const warn: Report = (rule, message, at) =>
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

  validateAdjustments(invoice, fail);
  validateVat(invoice, fail, warn);
  if (!readTotals(invoice.totals)) {
    fail("BR-12", "one of the invoice totals is missing or not a number", "totals");
  }

  // The arithmetic, each mismatch reported under the rule it comes from.
  for (const check of reconcile(invoice)) {
    if (!check.ok) fail(check.rule, check.message, check.at);
  }

  const fatal = violations.filter((v) => v.severity === "fatal");
  return {
    ok: fatal.length === 0,
    violations,
    fatal,
    warnings: violations.filter((v) => v.severity === "warning"),
  };
}

/** The same three questions of every document level allowance and charge. */
function validateAdjustments(invoice: Invoice, fail: Report): void {
  const each = (
    items: readonly AllowanceCharge[],
    list: string,
    noun: string,
    rules: { amount: string; category: string; reason: string },
  ) => {
    items.forEach((item, index) => {
      const at = `${list}[${index}]`;
      if (!safeDecimal(item.amount)) {
        fail(rules.amount, `the ${noun} has no amount, or it is not a number`, at);
      }
      if (!item.vatCategory) fail(rules.category, `the ${noun} has no VAT category`, at);
      if (!item.reason?.trim() && !item.reasonCode?.trim()) {
        fail(rules.reason, `the ${noun} gives no reason`, at);
      }
    });
  };

  each(invoice.allowances ?? [], "allowances", "allowance",
    { amount: "BR-31", category: "BR-32", reason: "BR-33" });
  each(invoice.charges ?? [], "charges", "charge",
    { amount: "BR-36", category: "BR-37", reason: "BR-38" });
}

function validateVat(invoice: Invoice, fail: Report, warn: Report): void {
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
      if (rate && !rate.equals(ZERO_RATE)) {
        fail(`BR-${group.category}-05`, `category ${group.category} must carry a zero rate, not ${group.rate}`, at);
      }
    }

    if (group.category === "S") {
      const rate = safeDecimal(group.rate);
      if (!rate || rate.compare(ZERO_RATE) <= 0) {
        fail("BR-S-05", "a standard-rated group must carry a rate above zero", at);
        return;
      }
      if (!safeDecimal(group.taxableAmount) || !safeDecimal(group.taxAmount)) {
        fail("BR-S-08", "the taxable or tax amount is not a number", at);
      }
    }
  });

  // Every category used on a line, an allowance or a charge must appear in the
  // breakdown, or the totals will be right by accident and wrong by
  // construction.
  const inBreakdown = new Set(invoice.vatBreakdown.map((g) => groupKey(g.category, g.rate)));
  const covered = (category: VatCategory, rate: string, at: string) => {
    if (!inBreakdown.has(groupKey(category, rate))) {
      fail("BR-CO-18", `no VAT breakdown group for category ${category} at ${rate}%`, at);
    }
  };
  invoice.lines.forEach((line, index) => covered(line.vatCategory, line.vatRate, `lines[${index}]`));
  (invoice.allowances ?? []).forEach((item, index) =>
    covered(item.vatCategory, item.vatRate, `allowances[${index}]`));
  (invoice.charges ?? []).forEach((item, index) =>
    covered(item.vatCategory, item.vatRate, `charges[${index}]`));

  if (invoice.vatBreakdown.length > inBreakdown.size) {
    warn("BR-CO-18", "two VAT breakdown groups share a category and rate; they should be one", "vatBreakdown");
  }
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
