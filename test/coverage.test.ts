import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice, Line } from "../src/model.ts";
import { ublPath } from "../src/paths.ts";
import { validate } from "../src/rules.ts";

const line = (id: string, netAmount: string): Line => ({
  id,
  name: "Consulting",
  quantity: 1,
  netPrice: netAmount,
  netAmount,
  vatCategory: "S",
  vatRate: "23",
});

/** A correct invoice: 200.00 at 23% VAT. */
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "FV-2026-0003",
    issueDate: "2026-08-16",
    typeCode: "380",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL", city: "Amsterdam" } },
    lines: [line("1", "200.00")],
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

// An invoice that passes should still be able to say what it passed.
test("the rules that ran are reported, not only the ones that failed", () => {
  const result = validate(invoice());

  assert.equal(result.violations.length, 0);
  assert.ok(result.coverage.every((entry) => entry.outcome === "pass"));
  const evaluated = result.coverage.map((entry) => entry.rule);
  for (const rule of ["BR-01", "BR-16", "BR-S-05", "BR-CO-13", "BR-S-09"]) {
    assert.ok(evaluated.includes(rule), `expected ${rule} to be evaluated`);
  }
});

// A rule that does not apply is absent rather than reported as passing.
test("a rule with nothing to check is not claimed as checked", () => {
  const withoutVatId = validate(
    invoice({ seller: { name: "Seller Sp. z o.o.", address: { countryCode: "PL" } } }),
  );
  assert.ok(!withoutVatId.coverage.some((entry) => entry.rule === "BR-CO-09"));
  assert.ok(validate(invoice()).coverage.some((entry) => entry.rule === "BR-CO-09"));
});

test("every outcome names an element of the document", () => {
  for (const entry of validate(invoice()).coverage) {
    assert.ok(entry.path?.startsWith("/Invoice"), `${entry.rule} at ${entry.at} has no path`);
  }
});

// The point of the whole thing: a failure is a place, not a boolean.
test("a failure carries the path of the offending element", () => {
  const result = validate({
    ...invoice(),
    lines: [{ ...line("1", "200.00"), netAmount: "250.00" }],
  });

  const violation = result.violations.find((v) => v.rule === "PEPPOL-EN16931-R120")!;
  assert.equal(violation.at, "lines[0].netAmount");
  assert.equal(violation.path, "/Invoice/InvoiceLine[1]/LineExtensionAmount");

  const payable = result.coverage.find((entry) => entry.rule === "BR-CO-16")!;
  assert.equal(payable.path, "/Invoice/LegalMonetaryTotal/PayableAmount");
});

test("a rule that runs per element is reported per element", () => {
  const result = validate(invoice({ lines: [line("1", "100.00"), line("", "100.00")] }));

  const identifiers = result.coverage.filter((entry) => entry.rule === "BR-21");
  assert.deepEqual(
    identifiers.map((entry) => [entry.outcome, entry.path]),
    [
      ["pass", "/Invoice/InvoiceLine[1]/ID"],
      ["fail", "/Invoice/InvoiceLine[2]/ID"],
    ],
  );
});

// UBL keeps allowances and charges in one list; the model keeps two.
test("a charge is found after the allowances that precede it", () => {
  assert.equal(ublPath("allowances[0].amount", 2), "/Invoice/AllowanceCharge[1]/Amount");
  assert.equal(
    ublPath("charges[0].reason", 2),
    "/Invoice/AllowanceCharge[3]/AllowanceChargeReason",
  );
  assert.equal(ublPath("nowhere"), undefined);
});
