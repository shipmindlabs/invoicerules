import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice, Line, LineAllowanceCharge } from "../src/model.ts";
import { ublPath } from "../src/paths.ts";
import { validate } from "../src/rules.ts";
import { toUBL } from "../src/ubl.ts";
import { computeVatBreakdown } from "../src/vat.ts";

const discount: LineAllowanceCharge = {
  amount: "20.00",
  baseAmount: "200.00",
  percentage: "10",
  reason: "Volume discount",
  reasonCode: "95",
};

const packaging: LineAllowanceCharge = { amount: "5.00", reason: "Packaging" };

/** 10 × 20.00, less a 20.00 line discount and plus a 5.00 line charge. */
function line(overrides: Partial<Line> = {}): Line {
  return {
    id: "1",
    name: "Consulting",
    quantity: 10,
    netPrice: "20.00",
    netAmount: "185.00",
    vatCategory: "S",
    vatRate: "23",
    allowances: [discount],
    charges: [packaging],
    ...overrides,
  };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "FV-2026-0004",
    issueDate: "2026-08-16",
    typeCode: "380",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL", city: "Amsterdam" } },
    lines: [line()],
    vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "185.00", taxAmount: "42.55" }],
    totals: {
      lineTotal: "185.00",
      taxExclusive: "185.00",
      taxTotal: "42.55",
      taxInclusive: "227.55",
      payable: "227.55",
    },
    ...overrides,
  };
}

const rules = (result: { violations: readonly { rule: string }[] }) =>
  result.violations.map((v) => v.rule);

// A line level discount never reaches BT-107; it is inside BT-131 already.
test("a line discount lands in the line net amount, the totals and the breakdown", () => {
  const result = validate(invoice());
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));

  const [group] = computeVatBreakdown(invoice());
  assert.equal(group.taxableAmount, "185.00");
  assert.equal(group.taxAmount, "42.55");
});

test("a line amount that forgets its own discount is caught", () => {
  const result = validate(invoice({ lines: [line({ netAmount: "205.00" })] }));
  const violation = result.violations.find((v) => v.rule === "PEPPOL-EN16931-R120")!;
  assert.match(violation.message, /less its allowances and plus its charges, 185\.00/);
  assert.equal(violation.path, "/Invoice/InvoiceLine[1]/LineExtensionAmount");
});

test("a line allowance or charge without a reason or an amount is refused", () => {
  const noReason = validate(invoice({ lines: [line({ allowances: [{ amount: "20.00" }] })] }));
  assert.ok(rules(noReason).includes("BR-42"));

  const noAmount = validate(
    invoice({ lines: [line({ charges: [{ amount: "free", reason: "Packaging" }] })] }),
  );
  assert.ok(rules(noAmount).includes("BR-43"));

  const chargeWithoutReason = validate(
    invoice({ lines: [line({ charges: [{ amount: "5.00" }] })] }),
  );
  assert.ok(rules(chargeWithoutReason).includes("BR-44"));
});

// A percentage and the amount it applies to only mean something together.
test("a percentage is checked against its base amount", () => {
  const wrong = validate(
    invoice({
      lines: [line({ allowances: [{ ...discount, baseAmount: "250.00" }] })],
    }),
  );
  const violation = wrong.violations.find((v) => v.rule === "PEPPOL-EN16931-R040")!;
  assert.match(violation.message, /is not 10% of 250\.00 = 25\.00/);
  assert.equal(violation.path, "/Invoice/InvoiceLine[1]/AllowanceCharge[1]/Amount");

  const noBase = validate(
    invoice({ lines: [line({ allowances: [{ amount: "20.00", percentage: "10", reason: "D" }] })] }),
  );
  assert.ok(rules(noBase).includes("PEPPOL-EN16931-R041"));

  const noPercentage = validate(
    invoice({
      lines: [line({ allowances: [{ amount: "20.00", baseAmount: "200.00", reason: "D" }] })],
    }),
  );
  assert.ok(rules(noPercentage).includes("PEPPOL-EN16931-R042"));
});

test("a document level allowance is checked the same way", () => {
  const result = validate(
    invoice({
      allowances: [
        { amount: "10.00", baseAmount: "100.00", percentage: "5", vatCategory: "S", vatRate: "23", reason: "D" },
      ],
    }),
  );
  const violation = result.violations.find((v) => v.rule === "PEPPOL-EN16931-R040")!;
  assert.equal(violation.path, "/Invoice/AllowanceCharge[1]/Amount");
});

test("the line carries its allowances and charges into the document", () => {
  const xml = toUBL(invoice());
  const start = xml.indexOf("<cac:AllowanceCharge>");
  const block = xml.slice(start, xml.indexOf("</cac:AllowanceCharge>"));

  assert.ok(start > xml.indexOf("<cac:InvoiceLine>"));
  assert.ok(start < xml.indexOf("<cac:Item>"));
  assert.ok(block.includes("<cbc:ChargeIndicator>false</cbc:ChargeIndicator>"));
  assert.ok(block.includes("<cbc:MultiplierFactorNumeric>10</cbc:MultiplierFactorNumeric>"));
  assert.ok(block.includes(`<cbc:BaseAmount currencyID="EUR">200.00</cbc:BaseAmount>`));
  // A line level allowance has no tax category; the line states it once.
  assert.ok(!block.includes("TaxCategory"));
  assert.ok(xml.includes("<cbc:AllowanceChargeReason>Packaging</cbc:AllowanceChargeReason>"));
  assert.ok(!xml.includes("<cbc:AllowanceTotalAmount"));
});

test("a line charge is found after the line allowances that precede it", () => {
  const context = { lineAllowances: [1] };
  assert.equal(
    ublPath("lines[0].allowances[0].baseAmount", context),
    "/Invoice/InvoiceLine[1]/AllowanceCharge[1]/BaseAmount",
  );
  assert.equal(
    ublPath("lines[0].charges[0].reason", context),
    "/Invoice/InvoiceLine[1]/AllowanceCharge[2]/AllowanceChargeReason",
  );
});
