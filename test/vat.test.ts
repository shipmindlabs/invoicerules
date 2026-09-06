import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice, Line, VatCategory } from "../src/model.ts";
import { validate } from "../src/rules.ts";
import { toUBL } from "../src/ubl.ts";
import { computeVatBreakdown, reconcile } from "../src/vat.ts";

const line = (id: string, netAmount: string, vatCategory: VatCategory, vatRate: string): Line => ({
  id,
  name: "Item",
  quantity: 1,
  netPrice: netAmount,
  netAmount,
  vatCategory,
  vatRate,
});

/** 250.00 of lines, a 25.00 discount and a 15.00 delivery charge, all at 23%. */
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "FV-2026-0002",
    issueDate: "2026-08-16",
    typeCode: "380",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL", city: "Amsterdam" } },
    lines: [line("1", "200.00", "S", "23"), line("2", "50.00", "S", "23")],
    allowances: [
      {
        amount: "25.00",
        baseAmount: "250.00",
        percentage: "10",
        vatCategory: "S",
        vatRate: "23",
        reason: "Volume discount",
        reasonCode: "95",
      },
    ],
    charges: [{ amount: "15.00", vatCategory: "S", vatRate: "23", reason: "Delivery" }],
    vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "240.00", taxAmount: "55.20" }],
    totals: {
      lineTotal: "250.00",
      allowanceTotal: "25.00",
      chargeTotal: "15.00",
      taxExclusive: "240.00",
      taxTotal: "55.20",
      taxInclusive: "295.20",
      payable: "295.20",
    },
    ...overrides,
  };
}

const rules = (result: { violations: readonly { rule: string }[] }) =>
  result.violations.map((v) => v.rule);

// A discount does not belong to the invoice, it belongs to a VAT group.
test("allowances and charges move the taxable amount of their own group", () => {
  const groups = computeVatBreakdown(invoice());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].taxableAmount, "240.00");
  assert.equal(groups[0].taxAmount, "55.20");
});

test("groups are keyed by category and rate as a number, not as text", () => {
  const groups = computeVatBreakdown({
    lines: [
      line("1", "100.00", "S", "23"),
      line("2", "100.00", "S", "23.00"),
      line("3", "300.00", "AE", "0"),
    ],
  });
  assert.deepEqual(groups.map((g) => `${g.category}@${g.rate}`), ["AE@0", "S@23"]);
  assert.equal(groups[1].taxableAmount, "200.00");
});

test("VAT per group is rounded half-up to the cent", () => {
  const [standard] = computeVatBreakdown({ lines: [line("1", "99.99", "S", "23")] });
  assert.equal(standard.taxAmount, "23.00");

  const [reduced] = computeVatBreakdown({ lines: [line("1", "33.33", "S", "7.5")] });
  assert.equal(reduced.taxAmount, "2.50");
});

test("an exemption reason already on the invoice is kept on the computed group", () => {
  const [group] = computeVatBreakdown({
    lines: [line("1", "300.00", "AE", "0")],
    vatBreakdown: [
      {
        category: "AE",
        rate: "0",
        taxableAmount: "300.00",
        taxAmount: "0.00",
        exemptionReason: "Reverse charge",
        exemptionReasonCode: "VATEX-EU-AE",
      },
    ],
  });
  assert.equal(group.exemptionReason, "Reverse charge");
  assert.equal(group.exemptionReasonCode, "VATEX-EU-AE");
});

// This is the invoice the library used to reject for carrying a discount.
test("an invoice with allowances and charges reconciles", () => {
  const result = validate(invoice());
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
});

test("each check names the rule and the term it comes from", () => {
  const checks = reconcile(invoice());
  assert.ok(checks.every((check) => check.ok));

  const byRule = new Map(checks.map((check) => [check.rule, check]));
  assert.equal(byRule.get("BR-CO-11")?.term, "BT-107");
  assert.equal(byRule.get("BR-CO-13")?.term, "BT-109");
  assert.equal(byRule.get("BR-CO-13")?.at, "totals.taxExclusive");
  assert.equal(byRule.get("BR-CO-16")?.at, "totals.payable");
  assert.equal(byRule.get("BR-45")?.expected, "240.00");
});

test("a total without VAT that forgets the discount is caught by BR-CO-13", () => {
  const result = validate(
    invoice({
      totals: {
        lineTotal: "250.00",
        allowanceTotal: "25.00",
        chargeTotal: "15.00",
        taxExclusive: "265.00",
        taxTotal: "55.20",
        taxInclusive: "320.20",
        payable: "320.20",
      },
    }),
  );
  assert.equal(result.ok, false);
  const violation = result.violations.find((v) => v.rule === "BR-CO-13")!;
  assert.match(violation.message, /250\.00 - 25\.00 \+ 15\.00 = 240\.00/);
});

test("a breakdown group that ignores the discount is caught by BR-45", () => {
  const result = validate(
    invoice({
      vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "250.00", taxAmount: "57.50" }],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes("BR-45"));
});

test("an allowance total that is not the sum of the allowances is caught", () => {
  const result = validate(
    invoice({
      allowances: [
        { amount: "25.00", vatCategory: "S", vatRate: "23", reason: "Volume discount" },
        { amount: "10.00", vatCategory: "S", vatRate: "23", reason: "Loyalty" },
      ],
    }),
  );
  assert.ok(rules(result).includes("BR-CO-11"));
});

test("an allowance without a reason is refused", () => {
  const result = validate(
    invoice({ allowances: [{ amount: "25.00", vatCategory: "S", vatRate: "23" }] }),
  );
  assert.ok(rules(result).includes("BR-33"));
});

test("what is already paid comes off the amount due", () => {
  const paid = {
    lineTotal: "250.00",
    allowanceTotal: "25.00",
    chargeTotal: "15.00",
    taxExclusive: "240.00",
    taxTotal: "55.20",
    taxInclusive: "295.20",
    prepaid: "100.00",
    payable: "195.20",
  };
  assert.equal(validate(invoice({ totals: paid })).ok, true);

  const ignored = validate(invoice({ totals: { ...paid, payable: "295.20" } }));
  const violation = ignored.violations.find((v) => v.rule === "BR-CO-16")!;
  assert.match(violation.message, /295\.20 - 100\.00 \+ 0\.00 = 195\.20/);
});

test("the document carries its allowances, charges and their totals", () => {
  const xml = toUBL(invoice());
  assert.ok(xml.includes("<cbc:ChargeIndicator>false</cbc:ChargeIndicator>"));
  assert.ok(xml.includes("<cbc:ChargeIndicator>true</cbc:ChargeIndicator>"));
  assert.ok(xml.includes("<cbc:AllowanceChargeReason>Volume discount</cbc:AllowanceChargeReason>"));
  assert.ok(xml.includes("<cbc:AllowanceChargeReason>Delivery</cbc:AllowanceChargeReason>"));
  assert.ok(xml.includes(`<cbc:AllowanceTotalAmount currencyID="EUR">25.00</cbc:AllowanceTotalAmount>`));
  assert.ok(xml.includes(`<cbc:ChargeTotalAmount currencyID="EUR">15.00</cbc:ChargeTotalAmount>`));
  assert.ok(xml.indexOf("<cac:AllowanceCharge>") < xml.indexOf("<cac:TaxTotal>"));
});
