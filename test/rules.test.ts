import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice } from "../src/model.ts";
import { validate } from "../src/rules.ts";

/** A correct invoice: 2 × 100.00 at 23% VAT. */
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "FV-2026-0001",
    issueDate: "2026-08-16",
    dueDate: "2026-09-15",
    typeCode: "380",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa", postalCode: "00-001", line1: "Ulica 1" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: {
      name: "Buyer BV",
      address: { countryCode: "NL", city: "Amsterdam", postalCode: "1011", line1: "Straat 2" },
      identification: { vatId: "NL123456789B01" },
    },
    lines: [
      {
        id: "1",
        name: "Consulting",
        quantity: 2,
        netPrice: "100.00",
        netAmount: "200.00",
        vatCategory: "S",
        vatRate: "23",
      },
    ],
    vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "200.00", taxAmount: "46.00" }],
    totals: {
      lineTotal: "200.00",
      taxExclusive: "200.00",
      taxTotal: "46.00",
      taxInclusive: "246.00",
      payable: "246.00",
    },
    ...overrides,
  };
}

const rules = (result: { violations: readonly { rule: string }[] }) =>
  result.violations.map((v) => v.rule);

test("a correct invoice passes", () => {
  const result = validate(invoice());
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  assert.equal(result.violations.length, 0);
});

test("missing identity fields are named by rule", () => {
  const result = validate(
    invoice({
      id: "",
      issueDate: "not a date",
      currency: "EURO",
      seller: { name: "", address: { countryCode: "XXX" } },
    }),
  );
  assert.equal(result.ok, false);
  for (const rule of ["BR-01", "BR-02", "BR-04", "BR-06", "BR-09"]) {
    assert.ok(rules(result).includes(rule), `expected ${rule} in ${rules(result).join(", ")}`);
  }
});

// The arithmetic checks are the ones that catch an invoice which looks right.
test("a line amount that does not match quantity times price is caught", () => {
  const result = validate(
    invoice({
      lines: [
        {
          id: "1",
          name: "Consulting",
          quantity: 2,
          netPrice: "100.00",
          netAmount: "250.00",
          vatCategory: "S",
          vatRate: "23",
        },
      ],
    }),
  );
  assert.equal(result.ok, false);
  const violation = result.violations.find((v) => v.rule === "PEPPOL-EN16931-R120")!;
  assert.match(violation.message, /2 × 100\.00 = 200\.00/);
  assert.equal(violation.at, "lines[0].netAmount");
  assert.equal(violation.path, "/Invoice/InvoiceLine[1]/LineExtensionAmount");
});

test("VAT that does not match the rate is caught", () => {
  const result = validate(
    invoice({
      vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "200.00", taxAmount: "40.00" }],
      totals: {
        lineTotal: "200.00",
        taxExclusive: "200.00",
        taxTotal: "40.00",
        taxInclusive: "240.00",
        payable: "240.00",
      },
    }),
  );
  assert.equal(result.ok, false);
  const violation = result.violations.find((v) => v.rule === "BR-S-09")!;
  assert.match(violation.message, /23% of 200\.00 = 46\.00/);
});

test("totals that do not add up are caught, each by its own rule", () => {
  const result = validate(
    invoice({
      totals: {
        lineTotal: "200.00",
        taxExclusive: "200.00",
        taxTotal: "46.00",
        taxInclusive: "250.00",
        payable: "999.00",
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes("BR-CO-15"));
  assert.ok(rules(result).includes("BR-CO-16"));
});

// Charging no VAT without saying why is the rejection that surprises people:
// the amount is right and the reason is missing.
test("a zero-VAT category without an exemption reason is refused", () => {
  const reverseCharge = invoice({
    lines: [
      {
        id: "1",
        name: "Consulting",
        quantity: 2,
        netPrice: "100.00",
        netAmount: "200.00",
        vatCategory: "AE",
        vatRate: "0",
      },
    ],
    vatBreakdown: [{ category: "AE", rate: "0", taxableAmount: "200.00", taxAmount: "0.00" }],
    totals: {
      lineTotal: "200.00",
      taxExclusive: "200.00",
      taxTotal: "0.00",
      taxInclusive: "200.00",
      payable: "200.00",
    },
  });

  assert.ok(rules(validate(reverseCharge)).includes("BR-AE-10"));

  const withReason = {
    ...reverseCharge,
    vatBreakdown: [
      {
        ...reverseCharge.vatBreakdown[0],
        exemptionReason: "Reverse charge",
        exemptionReasonCode: "VATEX-EU-AE",
      },
    ],
  };
  assert.equal(validate(withReason).ok, true);
});

test("a VAT identifier without its country prefix is caught", () => {
  const result = validate(
    invoice({
      seller: {
        name: "Seller Sp. z o.o.",
        address: { countryCode: "PL" },
        identification: { vatId: "5260250274" },
      },
    }),
  );
  assert.ok(rules(result).includes("BR-CO-09"));
});

test("a line whose category has no breakdown group is caught", () => {
  const result = validate(
    invoice({
      lines: [
        {
          id: "1",
          name: "Consulting",
          quantity: 2,
          netPrice: "100.00",
          netAmount: "200.00",
          vatCategory: "S",
          vatRate: "21",
        },
      ],
    }),
  );
  assert.ok(rules(result).includes("BR-CO-18"));
});

test("an invoice with no lines is refused", () => {
  assert.ok(rules(validate(invoice({ lines: [] }))).includes("BR-16"));
});

// One cent of rounding is normal and must not be an error.
test("a one-cent rounding difference is tolerated", () => {
  const result = validate(
    invoice({
      vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "200.00", taxAmount: "46.01" }],
      totals: {
        lineTotal: "200.00",
        taxExclusive: "200.00",
        taxTotal: "46.01",
        taxInclusive: "246.01",
        payable: "246.01",
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("two cents is not", () => {
  const result = validate(
    invoice({
      vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "200.00", taxAmount: "46.02" }],
      totals: {
        lineTotal: "200.00",
        taxExclusive: "200.00",
        taxTotal: "46.02",
        taxInclusive: "246.02",
        payable: "246.02",
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes("BR-S-09"));
});
