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
 * are what the other side's rejection message will quote; PEPPOL-EN16931-R0xx
 * are Peppol BIS Billing 3.0's, which apply because that is the customization
 * this library writes. The wording of each check is this library's own; the
 * normative text lives in EN 16931-1, which is published by CEN and not
 * reproduced here.
 */

import { Decimal } from "./decimal.ts";
import type { AllowanceCharge, Invoice, Line, LineAllowanceCharge, VatCategory } from "./model.ts";
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

/** Which rules an allowance or charge answers to at its own level. */
type AdjustmentRules = {
  readonly amount: string;
  readonly reason: string;
  /** Line level allowances and charges have no category of their own. */
  readonly category?: string;
};

/** Categories that charge no VAT and therefore need a reason. */
const NEEDS_EXEMPTION_REASON: ReadonlySet<VatCategory> = new Set(["Z", "E", "AE", "K", "G", "O"]);

const ZERO_RATE = Decimal.parse("0");
const ZERO = Decimal.zero(2);

export function validate(invoice: Invoice): Result {
  const coverage: RuleOutcome[] = [];
  const context = {
    allowances: invoice.allowances?.length ?? 0,
    lineAllowances: invoice.lines.map((line) => line.allowances?.length ?? 0),
  };

  const record = (rule: string, outcome: Outcome, message: string, at?: string): void => {
    coverage.push({
      rule,
      outcome,
      at,
      path: ublPath(at, context),
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

    validateAdjustments(line.allowances ?? [], `${at}.allowances`, "line allowance",
      { amount: "BR-41", reason: "BR-42" }, check);
    validateAdjustments(line.charges ?? [], `${at}.charges`, "line charge",
      { amount: "BR-43", reason: "BR-44" }, check);

    // The check that catches a wrong invoice that looks right. A line level
    // discount reaches the totals and the VAT breakdown only through BT-131,
    // so it has to be inside the line net amount before anything is added up.
    const adjusted = (line.allowances?.length ?? 0) + (line.charges?.length ?? 0) > 0;
    try {
      const expected = expectedLineNet(line);
      const stated = Decimal.parse(line.netAmount);
      check("BR-CO-16-LINE", stated.equalsWithin(expected, TOLERANCE), `${at}.netAmount`,
        adjusted
          ? `the line amount ${stated.toFixed()} does not match ${line.quantity} × ${line.netPrice} less its allowances and plus its charges, ${expected.toFixed()}`
          : `the line amount ${stated.toFixed()} does not match ${line.quantity} × ${line.netPrice} = ${expected.toFixed()}`);
    } catch {
      fail("BR-CO-16-LINE", "the line quantity, price or amount is not a number", `${at}.netAmount`);
    }
  });

  validateAdjustments(invoice.allowances ?? [], "allowances", "allowance",
    { amount: "BR-31", category: "BR-32", reason: "BR-33" }, check);
  validateAdjustments(invoice.charges ?? [], "charges", "charge",
    { amount: "BR-36", category: "BR-37", reason: "BR-38" }, check);

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

/** BT-131: quantity × price, less the line's own allowances and plus its charges. */
function expectedLineNet(line: Line): Decimal {
  const priced = Decimal.parse(line.netPrice).multiply(Decimal.parse(line.quantity)).round(2);
  const taken = sumAmounts(line.allowances ?? []);
  const added = sumAmounts(line.charges ?? []);
  return priced.subtract(taken).add(added).round(2);
}

function sumAmounts(items: readonly LineAllowanceCharge[]): Decimal {
  return items
    .reduce<Decimal>((total, item) => total.add(safeDecimal(item.amount) ?? ZERO), ZERO)
    .round(2);
}

/** The same questions of every allowance and charge, on a line or on the document. */
function validateAdjustments(
  items: readonly (AllowanceCharge | LineAllowanceCharge)[],
  list: string,
  noun: string,
  rules: AdjustmentRules,
  check: Check,
): void {
  items.forEach((item, index) => {
    const at = `${list}[${index}]`;
    check(rules.amount, !!safeDecimal(item.amount), `${at}.amount`,
      `the ${noun} has no amount, or it is not a number`);
    if (rules.category) {
      check(rules.category, "vatCategory" in item && !!item.vatCategory, `${at}.vatCategory`,
        `the ${noun} has no VAT category`);
    }
    check(rules.reason, !!(item.reason?.trim() || item.reasonCode?.trim()), `${at}.reason`,
      `the ${noun} gives no reason`);
    validatePercentage(item, at, noun, check);
  });
}

/**
 * A percentage and the amount it is a percentage of only mean something
 * together, and a receiver that recomputes one from the other has to get the
 * amount the document states.
 */
function validatePercentage(
  item: AllowanceCharge | LineAllowanceCharge,
  at: string,
  noun: string,
  check: Check,
): void {
  const base = safeDecimal(item.baseAmount);
  const percentage = safeDecimal(item.percentage);

  if (item.percentage !== undefined) {
    check("PEPPOL-EN16931-R041", !!base, `${at}.baseAmount`,
      `the ${noun} gives a percentage but no base amount to apply it to`);
  }
  if (item.baseAmount !== undefined) {
    check("PEPPOL-EN16931-R042", !!percentage, `${at}.percentage`,
      `the ${noun} gives a base amount but no percentage of it`);
  }

  const amount = safeDecimal(item.amount);
  if (!base || !percentage || !amount) return;
  const expected = base.percentOf(percentage).round(2);
  check("PEPPOL-EN16931-R040", amount.equalsWithin(expected, TOLERANCE), `${at}.amount`,
    `the ${noun} of ${amount.toFixed()} is not ${item.percentage}% of ${base.toFixed()} = ${expected.toFixed()}`);
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
  // construction. A line level allowance follows its line's category.
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
