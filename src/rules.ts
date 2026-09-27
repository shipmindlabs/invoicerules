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
 * list of failures that hides what was never checked. The same rules run over a
 * credit note, and the elements they name are the credit note's own.
 *
 * Rule identifiers (BR-*, BR-CO-*, BR-S-*) are the standard's own, because they
 * are what the other side's rejection message will quote; PEPPOL-EN16931-R0xx
 * are Peppol BIS Billing 3.0's, which apply because that is the customization
 * this library writes. Three identifiers are this library's own and are
 * prefixed so they cannot be mistaken for ones a receiver will quote back. The
 * wording of each check is this library's own; the normative text lives in
 * EN 16931-1, which is published by CEN and not reproduced here.
 */

import { Decimal } from "./decimal.ts";
import type { AllowanceCharge, Invoice, Line, LineAllowanceCharge, VatCategory } from "./model.ts";
import { isCreditNote, ublPath } from "./paths.ts";
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

/** One check a payment instruction is not put through here. */
export type UncheckedRule = {
  /** The identifier a receiver would quote, or the code list that would decide it. */
  readonly rule: string;
  /** What it is about, in the terms the standard uses. */
  readonly about: string;
  /** Why it is not checked here. */
  readonly note: string;
};

/**
 * What a payment instruction is not checked for, named rather than implied. A
 * library that says "payment means supported" and means four rules out of ten
 * is worse than one that lists the six.
 */
export const UNCHECKED_PAYMENT_RULES: readonly UncheckedRule[] = [
  {
    rule: "BR-CO-25",
    about: "a positive amount due needs either a due date (BT-9) or payment terms (BT-20)",
    note: "both terms are modelled and written; neither is required yet",
  },
  {
    rule: "BR-51",
    about: "the last digits of a payment card primary account number (BT-87)",
    note: "payment card information (BG-18) is not modelled",
  },
  {
    rule: "PEPPOL-EN16931-R061",
    about: "a direct debit needs a mandate reference (BT-89)",
    note: "direct debit (BG-19), its creditor identifier (BT-90) and debited account (BT-91) are not modelled",
  },
  {
    rule: "UNCL4461",
    about: "the payment means code (BT-81) is one the code list has",
    note: "the code is required and read — 30, 31 and 58 mean a credit transfer — but not checked against the list",
  },
  {
    rule: "ISO 13616",
    about: "an account identifier (BT-84) that is not an IBAN",
    note: "check digits are verified where the identifier is in IBAN shape; national account numbers are left alone rather than guessed at",
  },
];

/** Categories that charge no VAT and therefore need a reason. */
const NEEDS_EXEMPTION_REASON: ReadonlySet<VatCategory> = new Set(["Z", "E", "AE", "K", "G", "O"]);

/** UNCL4461 codes that mean a credit transfer, which is what BR-61 turns on. */
const CREDIT_TRANSFER_CODES: ReadonlySet<string> = new Set(["30", "31", "58"]);

/**
 * Not an identifier any validator will quote: a document states its amounts
 * positively, and a refund is a credit note (BT-3) rather than an invoice with
 * a minus sign in front of it. The prefix says as much.
 */
const POSITIVE_AMOUNTS = "INVOICERULES-CN-01";

/** Also this library's own: a due date that is a date, is not before the issue
 * date, and has an element to be written into. */
const DUE_DATE = "INVOICERULES-DUE-01";

/** And this one: the check digits of an account identifier in IBAN shape. */
const IBAN_CHECK_DIGITS = "INVOICERULES-IBAN-01";

const ZERO_RATE = Decimal.parse("0");
const ZERO = Decimal.zero(2);

export function validate(invoice: Invoice): Result {
  const coverage: RuleOutcome[] = [];
  const creditNote = isCreditNote(invoice);
  const context = {
    allowances: invoice.allowances?.length ?? 0,
    lineAllowances: invoice.lines.map((line) => line.allowances?.length ?? 0),
    creditNote,
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

  // The direction of the money is the document type code, not the sign of the
  // amounts. A receiver that reads the sign instead of the code books the same
  // money twice, so a negative amount is refused in either document.
  const notNegative = (at: string, what: string, amount: Decimal | undefined): void => {
    if (!amount) return;
    check(POSITIVE_AMOUNTS, amount.compare(ZERO) >= 0, at,
      creditNote
        ? `${what} ${amount.toFixed()} is negative; a credit note states what it credits as a positive amount`
        : `${what} ${amount.toFixed()} is negative; a refund is a credit note (type code 381), not an invoice with a minus sign`);
  };

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

  validatePayment(invoice, creditNote, check, fail, warn);

  invoice.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    check("BR-21", !!line.id?.trim(), `${at}.id`, "the line has no identifier");
    check("BR-25", !!line.name?.trim(), `${at}.name`, "the line has no item name");
    check("BR-CO-04", !!line.vatCategory, `${at}.vatCategory`, "the line has no VAT category");

    // BT-146 is the one amount the standard names outright as never negative.
    const netPrice = safeDecimal(line.netPrice);
    if (netPrice) {
      check("BR-27", netPrice.compare(ZERO) >= 0, `${at}.netPrice`,
        `the item net price ${netPrice.toFixed()} is negative`);
    }
    notNegative(`${at}.quantity`, "the line quantity", safeDecimal(String(line.quantity)));
    notNegative(`${at}.netAmount`, "the line amount", safeDecimal(line.netAmount));

    validateAdjustments(line.allowances ?? [], `${at}.allowances`, "line allowance",
      { amount: "BR-41", reason: "BR-42" }, check);
    validateAdjustments(line.charges ?? [], `${at}.charges`, "line charge",
      { amount: "BR-43", reason: "BR-44" }, check);

    // The check that catches a wrong invoice that looks right. A line level
    // discount reaches the totals and the VAT breakdown only through BT-131,
    // so it has to be inside the line net amount before anything is added up.
    // EN 16931 leaves the line arithmetic to the syntax bindings, so the rule a
    // receiver quotes for it is Peppol's R120 rather than a BR-CO.
    const adjusted = (line.allowances?.length ?? 0) + (line.charges?.length ?? 0) > 0;
    try {
      const expected = expectedLineNet(line);
      const stated = Decimal.parse(line.netAmount);
      check("PEPPOL-EN16931-R120", stated.equalsWithin(expected, TOLERANCE), `${at}.netAmount`,
        adjusted
          ? `the line amount ${stated.toFixed()} does not match ${line.quantity} × ${line.netPrice} less its allowances and plus its charges, ${expected.toFixed()}`
          : `the line amount ${stated.toFixed()} does not match ${line.quantity} × ${line.netPrice} = ${expected.toFixed()}`);
    } catch {
      fail("PEPPOL-EN16931-R120", "the line quantity, price or amount is not a number", `${at}.netAmount`);
    }
  });

  validateAdjustments(invoice.allowances ?? [], "allowances", "allowance",
    { amount: "BR-31", category: "BR-32", reason: "BR-33" }, check);
  validateAdjustments(invoice.charges ?? [], "charges", "charge",
    { amount: "BR-36", category: "BR-37", reason: "BR-38" }, check);

  validateVat(invoice, check, fail, warn);
  invoice.vatBreakdown.forEach((group, index) =>
    notNegative(`vatBreakdown[${index}].taxableAmount`, "the taxable amount",
      safeDecimal(group.taxableAmount)));

  const totals = readTotals(invoice.totals);
  check("BR-12", !!totals, "totals", "one of the invoice totals is missing or not a number");
  if (totals) {
    // BT-114 is negative by design when the amount due rounds down, and BT-115
    // goes negative when more was prepaid than was owed. Neither is a refund.
    notNegative("totals.lineTotal", "the line total", totals.lineTotal);
    notNegative("totals.taxExclusive", "the total without VAT", totals.taxExclusive);
    notNegative("totals.taxInclusive", "the total with VAT", totals.taxInclusive);
  }

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

/**
 * When it is due, who is paid and how. The means code decides the rest: a
 * credit transfer with no account identifier is an invoice nobody can pay, and
 * an IBAN with a transposed pair is money that arrives somewhere else while the
 * document stays structurally perfect.
 */
function validatePayment(
  invoice: Invoice,
  creditNote: boolean,
  check: Check,
  fail: Report,
  warn: Report,
): void {
  const instructions = invoice.paymentMeans ?? [];

  if (invoice.dueDate !== undefined) {
    if (!isDate(invoice.dueDate)) {
      fail(DUE_DATE, `the due date "${invoice.dueDate}" is not a date`, "dueDate");
    } else if (isDate(invoice.issueDate)) {
      check(DUE_DATE, invoice.dueDate >= invoice.issueDate, "dueDate",
        `the due date ${invoice.dueDate} is before the issue date ${invoice.issueDate}`);
    }
    // UBL keeps a credit note's BT-9 inside the payment instruction, so without
    // one there is nowhere to write it and the date is silently lost.
    if (creditNote && instructions.length === 0) {
      warn(DUE_DATE,
        "a credit note carries its due date inside a payment instruction (BG-16); with none, the due date will not be written",
        "dueDate");
    }
  }

  if (invoice.payee) {
    check("BR-17", !!invoice.payee.name?.trim(), "payee.name",
      "the invoice names a payee other than the seller but gives it no name");
  }

  instructions.forEach((means, index) => {
    const at = `paymentMeans[${index}]`;
    const code = means.typeCode?.trim() ?? "";
    check("BR-49", !!code, `${at}.typeCode`,
      "the payment instruction gives no payment means code (BT-81)");

    const account = means.creditTransfer?.accountId?.trim();
    if (means.creditTransfer) {
      check("BR-50", !!account, `${at}.creditTransfer.accountId`,
        "the credit transfer names no account for the money to go to (BT-84)");
    }
    if (CREDIT_TRANSFER_CODES.has(code)) {
      check("BR-61", !!account, `${at}.creditTransfer.accountId`,
        `payment means ${code} is a credit transfer, so the account the money goes to (BT-84) has to be given`);
    }
    if (account && looksLikeIban(account)) {
      check(IBAN_CHECK_DIGITS, ibanChecksumHolds(account), `${at}.creditTransfer.accountId`,
        `the account identifier "${account}" is in IBAN shape but its check digits do not hold`);
    }
  });
}

/** Two letters, two check digits, then the account. Anything else is not an IBAN. */
function looksLikeIban(value: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact(value));
}

/** ISO 7064 mod 97-10: the first four characters move to the end, letters become numbers. */
function ibanChecksumHolds(value: string): boolean {
  const account = compact(value);
  if (account.length < 15 || account.length > 34) return false;

  let remainder = 0;
  for (const character of account.slice(4) + account.slice(0, 4)) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function compact(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
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
    // Which list it is in decides whether it is taken off or added on, so a
    // negative amount here reverses the sign a second time.
    const amount = safeDecimal(item.amount);
    check(rules.amount, !!amount && amount.compare(ZERO) >= 0, `${at}.amount`,
      `the ${noun} has no amount, or it is not a positive number`);
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
