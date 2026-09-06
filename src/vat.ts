/**
 * VAT subtotals per category and rate, and the arithmetic a document has to
 * satisfy before it is issued.
 *
 * A breakdown group is not a summary of the lines. A document level discount
 * belongs to a category and a rate as well and moves the taxable amount of
 * that group, so an invoice that reports VAT on the undiscounted lines is
 * consistent with itself and still wrong. The groups here are computed from
 * lines, allowances and charges together.
 *
 * Every check carries the rule identifier and the business term it constrains,
 * because a mismatch found at your own desk and a rejection from a tax
 * platform should name the same thing.
 */

import { Decimal } from "./decimal.ts";
import type { Invoice, Totals, VatBreakdown, VatCategory } from "./model.ts";

const ZERO = Decimal.zero(2);

/** The rounding difference the rules tolerate on a total. */
export const TOLERANCE = Decimal.parse("0.01");

/** What a breakdown can be computed from. */
export type VatInput = Pick<Invoice, "lines"> &
  Partial<Pick<Invoice, "allowances" | "charges" | "vatBreakdown">>;

/** One rule, checked against one pair of amounts. */
export type RuleCheck = {
  /** The standard's identifier, which is what a rejection message will quote. */
  readonly rule: string;
  /** The business term the rule constrains, e.g. "BT-109". */
  readonly term: string;
  /** Where the amount lives, e.g. "totals.taxExclusive". */
  readonly at: string;
  readonly ok: boolean;
  /** What the document says. */
  readonly stated: string;
  /** What the rule derives. */
  readonly expected: string;
  /** Why the two differ. Meaningful only when `ok` is false. */
  readonly message: string;
};

/** The invoice totals as numbers, or nothing if one of them is not a number. */
export type NumericTotals = { readonly [K in keyof Required<Totals>]: Decimal };

/** BR-CO-17: the VAT on a taxable amount, rounded to the cent, half up. */
export function taxOf(taxableAmount: Decimal, rate: Decimal): Decimal {
  return taxableAmount.percentOf(rate).round(2);
}

/** The subtotals per (category, rate) the lines, allowances and charges imply. */
export function computeVatBreakdown(input: VatInput): readonly VatBreakdown[] {
  type Group = { category: VatCategory; rate: string; taxable: Decimal };
  const groups = new Map<string, Group>();

  const contribute = (category: VatCategory, rate: string, amount: Decimal) => {
    const id = groupKey(category, rate);
    const group = groups.get(id);
    if (group) group.taxable = group.taxable.add(amount);
    else groups.set(id, { category, rate, taxable: amount });
  };

  for (const line of input.lines) {
    contribute(line.vatCategory, line.vatRate, parse(line.netAmount) ?? ZERO);
  }
  for (const allowance of input.allowances ?? []) {
    contribute(allowance.vatCategory, allowance.vatRate, ZERO.subtract(parse(allowance.amount) ?? ZERO));
  }
  for (const charge of input.charges ?? []) {
    contribute(charge.vatCategory, charge.vatRate, parse(charge.amount) ?? ZERO);
  }

  const stated = new Map((input.vatBreakdown ?? []).map((g) => [groupKey(g.category, g.rate), g]));

  return [...groups.values()]
    .sort((a, b) => a.category.localeCompare(b.category) || rateOrder(a.rate, b.rate))
    .map(({ category, rate, taxable }) => {
      const taxableAmount = taxable.round(2);
      const parsedRate = parse(rate);
      const known = stated.get(groupKey(category, rate));
      return {
        category,
        rate,
        taxableAmount: taxableAmount.toFixed(2),
        taxAmount: (parsedRate ? taxOf(taxableAmount, parsedRate) : ZERO).toFixed(2),
        ...(known?.exemptionReason === undefined ? {} : { exemptionReason: known.exemptionReason }),
        ...(known?.exemptionReasonCode === undefined
          ? {}
          : { exemptionReasonCode: known.exemptionReasonCode }),
      };
    });
}

/**
 * Every arithmetic check the document has to pass, whether it passes or not.
 * Returned rather than thrown so a caller can show which rule an amount
 * answers to, not only what failed.
 */
export function reconcile(invoice: Invoice): readonly RuleCheck[] {
  const checks: RuleCheck[] = [];
  const computed = new Map(
    computeVatBreakdown(invoice).map((group) => [groupKey(group.category, group.rate), group]),
  );

  invoice.vatBreakdown.forEach((group, index) => {
    const at = `vatBreakdown[${index}]`;
    const taxable = parse(group.taxableAmount);
    const rate = parse(group.rate);
    if (!taxable || !rate) return;

    const fromDocument = computed.get(groupKey(group.category, group.rate));
    const expectedTaxable = fromDocument ? Decimal.parse(fromDocument.taxableAmount) : ZERO;
    checks.push(
      checked({
        rule: "BR-45",
        term: "BT-116",
        at,
        stated: taxable,
        expected: expectedTaxable,
        message: `the taxable amount ${taxable.toFixed()} for category ${group.category} at ${group.rate}% does not match its lines, allowances and charges, ${expectedTaxable.toFixed()}`,
      }),
    );

    const tax = parse(group.taxAmount);
    if (!tax) return;
    const expectedTax = taxOf(taxable, rate);
    checks.push(
      checked({
        // BR-S-09 says of standard-rated groups what BR-CO-17 says of all of
        // them; naming the narrower rule matches what a validator reports.
        rule: group.category === "S" ? "BR-S-09" : "BR-CO-17",
        term: "BT-117",
        at,
        stated: tax,
        expected: expectedTax,
        message: `VAT of ${tax.toFixed()} does not match ${group.rate}% of ${taxable.toFixed()} = ${expectedTax.toFixed()}`,
      }),
    );
  });

  const totals = readTotals(invoice.totals);
  if (!totals) return checks;

  const lineSum = sumAmounts(invoice.lines.map((line) => line.netAmount));
  const allowanceSum = sumAmounts((invoice.allowances ?? []).map((item) => item.amount));
  const chargeSum = sumAmounts((invoice.charges ?? []).map((item) => item.amount));
  const taxSum = sumAmounts(invoice.vatBreakdown.map((group) => group.taxAmount));

  checks.push(
    checked({
      rule: "BR-CO-10",
      term: "BT-106",
      at: "totals.lineTotal",
      stated: totals.lineTotal,
      expected: lineSum,
      message: `the line total ${totals.lineTotal.toFixed()} is not the sum of the lines, ${lineSum.toFixed()}`,
    }),
    checked({
      rule: "BR-CO-11",
      term: "BT-107",
      at: "totals.allowanceTotal",
      stated: totals.allowanceTotal,
      expected: allowanceSum,
      message: `the allowance total ${totals.allowanceTotal.toFixed()} is not the sum of the document level allowances, ${allowanceSum.toFixed()}`,
    }),
    checked({
      rule: "BR-CO-12",
      term: "BT-108",
      at: "totals.chargeTotal",
      stated: totals.chargeTotal,
      expected: chargeSum,
      message: `the charge total ${totals.chargeTotal.toFixed()} is not the sum of the document level charges, ${chargeSum.toFixed()}`,
    }),
  );

  const expectedExclusive = totals.lineTotal.subtract(totals.allowanceTotal).add(totals.chargeTotal).round(2);
  const adjusted = !totals.allowanceTotal.equals(ZERO) || !totals.chargeTotal.equals(ZERO);
  checks.push(
    checked({
      rule: "BR-CO-13",
      term: "BT-109",
      at: "totals.taxExclusive",
      stated: totals.taxExclusive,
      expected: expectedExclusive,
      message: adjusted
        ? `the total without VAT ${totals.taxExclusive.toFixed()} does not equal ${totals.lineTotal.toFixed()} - ${totals.allowanceTotal.toFixed()} + ${totals.chargeTotal.toFixed()} = ${expectedExclusive.toFixed()}`
        : `the total without VAT ${totals.taxExclusive.toFixed()} does not match the line total ${totals.lineTotal.toFixed()}`,
    }),
    checked({
      rule: "BR-CO-14",
      term: "BT-110",
      at: "totals.taxTotal",
      stated: totals.taxTotal,
      expected: taxSum,
      message: `the VAT total ${totals.taxTotal.toFixed()} is not the sum of the VAT breakdown, ${taxSum.toFixed()}`,
    }),
  );

  const expectedInclusive = totals.taxExclusive.add(totals.taxTotal).round(2);
  checks.push(
    checked({
      rule: "BR-CO-15",
      term: "BT-112",
      at: "totals.taxInclusive",
      stated: totals.taxInclusive,
      expected: expectedInclusive,
      message: `the total with VAT ${totals.taxInclusive.toFixed()} does not equal ${totals.taxExclusive.toFixed()} + ${totals.taxTotal.toFixed()}`,
    }),
  );

  const expectedPayable = totals.taxInclusive.subtract(totals.prepaid).add(totals.rounding).round(2);
  const settled = !totals.prepaid.equals(ZERO) || !totals.rounding.equals(ZERO);
  checks.push(
    checked({
      rule: "BR-CO-16",
      term: "BT-115",
      at: "totals.payable",
      stated: totals.payable,
      expected: expectedPayable,
      message: settled
        ? `the amount due ${totals.payable.toFixed()} does not equal ${totals.taxInclusive.toFixed()} - ${totals.prepaid.toFixed()} + ${totals.rounding.toFixed()} = ${expectedPayable.toFixed()}`
        : `the amount due ${totals.payable.toFixed()} does not match the total with VAT ${totals.taxInclusive.toFixed()}`,
    }),
  );

  return checks;
}

/** The totals as numbers. Nothing at all if one of them is not a number. */
export function readTotals(totals: Totals | undefined): NumericTotals | undefined {
  if (!totals) return undefined;
  const optional = (value: string | undefined) => (value === undefined ? ZERO : parse(value));

  const lineTotal = parse(totals.lineTotal);
  const allowanceTotal = optional(totals.allowanceTotal);
  const chargeTotal = optional(totals.chargeTotal);
  const taxExclusive = parse(totals.taxExclusive);
  const taxTotal = parse(totals.taxTotal);
  const taxInclusive = parse(totals.taxInclusive);
  const prepaid = optional(totals.prepaid);
  const rounding = optional(totals.rounding);
  const payable = parse(totals.payable);

  if (!lineTotal || !allowanceTotal || !chargeTotal || !taxExclusive || !taxTotal) return undefined;
  if (!taxInclusive || !prepaid || !rounding || !payable) return undefined;

  return {
    lineTotal,
    allowanceTotal,
    chargeTotal,
    taxExclusive,
    taxTotal,
    taxInclusive,
    prepaid,
    rounding,
    payable,
  };
}

/** Groups are the same group when the rates are the same number, not the same text. */
export function groupKey(category: VatCategory, rate: string): string {
  const parsed = parse(rate);
  return `${category}@${parsed ? parsed.toFixed(2) : rate.trim()}`;
}

type Comparison = {
  readonly rule: string;
  readonly term: string;
  readonly at: string;
  readonly stated: Decimal;
  readonly expected: Decimal;
  readonly message: string;
};

function checked({ rule, term, at, stated, expected, message }: Comparison): RuleCheck {
  return {
    rule,
    term,
    at,
    ok: stated.equalsWithin(expected, TOLERANCE),
    stated: stated.toFixed(2),
    expected: expected.toFixed(2),
    message,
  };
}

function rateOrder(left: string, right: string): number {
  return (parse(left) ?? ZERO).compare(parse(right) ?? ZERO);
}

function sumAmounts(values: readonly string[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.add(parse(value) ?? ZERO), ZERO).round(2);
}

function parse(value: string | undefined): Decimal | undefined {
  if (value === undefined) return undefined;
  try {
    return Decimal.parse(value);
  } catch {
    return undefined;
  }
}
