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
 * Every rule that runs is reported, passing or not, against the element it
 * looked at: "invalid" is not something anyone can act on, and neither is a
 * list of failures that hides what was never checked.
 *
 * Rule identifiers (BR-*, BR-CO-*, BR-S-*) are the standard's own, because they
 * are what the other side's rejection message will quote. The wording of each
 * check is this library's own; the normative text lives in EN 16931-1, which is
 * published by CEN and not reproduced here.
 */

import { Decimal } from "./decimal.ts";
import type { AllowanceCharge, Invoice, VatCategory } from "./model.ts";
import { ublPath } from "./paths.ts";
import { TOLERANCE, groupKey, readTotals, reconcile } from "./vat.ts";

export type Severity = "fatal" | "warning";

export type Outcome = "pass" | "fail" | "warning";

/** One rule, evaluated against one element. */
export type RuleOutcome = {
  readonly rule: string;
  readonly outcome: Outcome;
  /** Where in the model, e.g. "lines[2].netAmount". */
  readonly at?: string;
  /** The same element in the document, e.g. "/Invoice/InvoiceLine[3]/Price". */
  readonly path?: string;
  /** Why it failed. Absent on a pass. */
  readonly message?: string;
};

export type Violation = {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  /** Where the problem is, e.g. "lines[2].netAmount" or "totals.taxInclusive". */
  readonly at?: string;
  /** The same place in the document, e.g. "/Invoice/InvoiceLine[3]/Price". */
  readonly path?: string;
};

export type Result = {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
  readonly fatal: readonly Violation[];
  readonly warnings: readonly Violation[];
  /** Every rule that was evaluated, in the order it ran. */
  readonly coverage: readonly RuleOutcome[];
};

type Report = (rule: string, message: string, at?: string) => void;
type Check = (rule: string, ok: boolean, at: string, message: string) => void;

/** Categories that charge no VAT and therefore need a reason. */
const NEEDS_EXEMPTION_REASON: ReadonlySet<VatCategory> = new Set(["Z", "E", "AE", "K", "G", "O"]);

const ZERO_RATE = Decimal.parse("0");

export function validate(invoice: Invoice): Result {
  const coverage: RuleOutcome[] = [];
  const allowanceCount = invoice.allowances?.length ?? 0;

  const record = (rule: string, outcome: Outcome, message: string, at?: string): void => {
    coverage.push({
      rule,
      outcome,
      at,
      path: ublPath(at, allowanceCount),
      message: outcome === "pass" ? undefined : message,
    });
  };
  const check: Check = (rule, ok, at, message) => record(rule, ok ? "pass" : "fail", message, at);
  const fail: Report = (rule, message, at) => record(rule, "fail", message, at);
  const warn: Report = (rule, message, at) => record(rule, "warning", message, at);

  // Presence rules. Dull, and the majority of real rejections.
  check("BR-01", !!invoice.id?.trim(), "id", "the invoice has no number");
  check("BR-02", isDate(invoice.issueDate), "issueDate", "the issue date is missing or not a date");
  check("BR-03", !!invoice.typeCode?.trim(), "typeCode", "the invoice type code is missing");
  check("BR-04", isCurrency(invoice.currency), "currency",
    `"${invoice.currency}" is not a three-letter ISO 4217 currency`);
  check("BR-06", !!invoice.seller?.name?.trim(), "seller.name", "the seller has no name");
  check("BR-07", !!invoice.buyer?.name?.trim(), "buyer.name", "the buyer has no name");
  check("BR-09", isCountry(invoice.seller?.address?.countryCode), "seller.address.countryCode",
    "the seller's country is missing or not an ISO 3166-1 code");
  check("BR-11", isCountry(invoice.buyer?.address?.countryCode), "buyer.address.countryCode",
    "the buyer's country is missing or not an ISO 3166-1 code");
  check("BR-16", invoice.lines.length > 0, "lines", "the invoice has no lines");

  // A VAT identifier that does not start with its country is the single most
  // common reason a cross-border invoice bounces.
  const sellerVat = invoice.seller?.identification?.vatId;
  if (sellerVat) {
    check("BR-CO-09", /^[A-Z]{2}/.test(sellerVat), "seller.identification.vatId",
      `the seller's VAT identifier "${sellerVat}" does not start with a country code`);
  }

  invoice.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    check("BR-21", !!line.id?.trim(), `${at}.id`, "the line has no identifier");
    check("BR-25", !!line.name?.trim(), `${at}.name`, "the line has no item name");
    check("BR-CO-04", !!line.vatCategory, `${at}.vatCategory`, "the line has no VAT category");

    // The check that catches a wrong invoice that looks right.
    try {
      const expected = Decimal.parse(line.netPrice).multiply(Decimal.parse(line.quantity)).round(2);
      const stated = Decimal.parse(line.netAmount);
      check("BR-CO-16-LINE", stated.equalsWithin(expected, TOLERANCE), `${at}.netAmount`,
        `the line amount ${stated.toFixed()} does not match ${line.quantity} × ${line.netPrice} = ${expected.toFixed()}`);
    } catch {
      fail("BR-CO-16-LINE", "the line quantity, price or amount is not a number", `${at}.netAmount`);
    }
  });

  validateAdjustments(invoice, check);
  validateVat(invoice, check, fail, warn);
  check("BR-12", !!readTotals(invoice.totals), "totals",
    "one of the invoice totals is missing or not a number");

  // The arithmetic, each comparison reported under the rule it comes from.
  for (const arithmetic of reconcile(invoice)) {
    record(arithmetic.rule, arithmetic.ok ? "pass" : "fail", arithmetic.message, arithmetic.at);
  }

  const violations = coverage.filter((entry) => entry.outcome !== "pass").map(asViolation);
  const fatal = violations.filter((v) => v.severity === "fatal");
  return {
    ok: fatal.length === 0,
    violations,
    fatal,
    warnings: violations.filter((v) => v.severity === "warning"),
    coverage,
  };
}

function asViolation(entry: RuleOutcome): Violation {
  return {
    rule: entry.rule,
    severity: entry.outcome === "warning" ? "warning" : "fatal",
    message: entry.message ?? "",
    at: entry.at,
    path: entry.path,
  };
}

/** The same three questions of every document level allowance and charge. */
function validateAdjustments(invoice: Invoice, check: Check): void {
  const each = (
    items: readonly AllowanceCharge[],
    list: string,
    noun: string,
    rules: { amount: string; category: string; reason: string },
  ) => {
    items.forEach((item, index) => {
      const at = `${list}[${index}]`;
      check(rules.amount, !!safeDecimal(item.amount), `${at}.amount`,
        `the ${noun} has no amount, or it is not a number`);
      check(rules.category, !!item.vatCategory, `${at}.vatCategory`,
        `the ${noun} has no VAT category`);
      check(rules.reason, !!(item.reason?.trim() || item.reasonCode?.trim()), `${at}.reason`,
        `the ${noun} gives no reason`);
    });
  };

  each(invoice.allowances ?? [], "allowances", "allowance",
    { amount: "BR-31", category: "BR-32", reason: "BR-33" });
  each(invoice.charges ?? [], "charges", "charge",
    { amount: "BR-36", category: "BR-37", reason: "BR-38" });
}

function validateVat(invoice: Invoice, check: Check, fail: Report, warn: Report): void {
  if (invoice.vatBreakdown.length === 0) {
    fail("BR-CO-18", "the invoice has no VAT breakdown", "vatBreakdown");
    return;
  }

  invoice.vatBreakdown.forEach((group, index) => {
    const at = `vatBreakdown[${index}]`;

    // Charging nothing without saying why is the rejection that surprises
    // people: the amount is right, the reason is missing.
    if (NEEDS_EXEMPTION_REASON.has(group.category)) {
      check(`BR-${group.category}-10`,
        !!(group.exemptionReason?.trim() || group.exemptionReasonCode?.trim()),
        `${at}.exemptionReason`,
        `category ${group.category} charges no VAT but gives no exemption reason`);
      const rate = safeDecimal(group.rate);
      if (rate) {
        check(`BR-${group.category}-05`, rate.equals(ZERO_RATE), `${at}.rate`,
          `category ${group.category} must carry a zero rate, not ${group.rate}`);
      }
    }

    if (group.category === "S") {
      const rate = safeDecimal(group.rate);
      const rated = !!rate && rate.compare(ZERO_RATE) > 0;
      check("BR-S-05", rated, `${at}.rate`, "a standard-rated group must carry a rate above zero");
      if (!rated) return;
      check("BR-S-08", !!safeDecimal(group.taxableAmount) && !!safeDecimal(group.taxAmount),
        `${at}.taxAmount`, "the taxable or tax amount is not a number");
    }
  });

  // Every category used on a line, an allowance or a charge must appear in the
  // breakdown, or the totals will be right by accident and wrong by
  // construction.
  const inBreakdown = new Set(invoice.vatBreakdown.map((g) => groupKey(g.category, g.rate)));
  const covered = (category: VatCategory, rate: string, at: string) =>
    check("BR-CO-18", inBreakdown.has(groupKey(category, rate)), at,
      `no VAT breakdown group for category ${category} at ${rate}%`);
  invoice.lines.forEach((line, index) =>
    covered(line.vatCategory, line.vatRate, `lines[${index}].vatCategory`));
  (invoice.allowances ?? []).forEach((item, index) =>
    covered(item.vatCategory, item.vatRate, `allowances[${index}].vatCategory`));
  (invoice.charges ?? []).forEach((item, index) =>
    covered(item.vatCategory, item.vatRate, `charges[${index}].vatCategory`));

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
