import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice, Line } from "../src/model.ts";
import { isCreditNote } from "../src/paths.ts";
import { validate } from "../src/rules.ts";
import { toUBL } from "../src/ubl.ts";

const line = (netPrice: string, netAmount: string): Line => ({
  id: "1",
  name: "Consulting",
  quantity: 2,
  netPrice,
  netAmount,
  vatCategory: "S",
  vatRate: "23",
});

/** 2 × 100.00 at 23%, credited back to the buyer. */
function creditNote(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "KOR-2026-0001",
    issueDate: "2026-08-20",
    typeCode: "381",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL", city: "Amsterdam" } },
    lines: [line("100.00", "200.00")],
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

/** The same figures with a minus sign and an invoice type code. */
const negative: Invoice = creditNote({
  typeCode: "380",
  lines: [line("-100.00", "-200.00")],
  vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "-200.00", taxAmount: "-46.00" }],
  totals: {
    lineTotal: "-200.00",
    taxExclusive: "-200.00",
    taxTotal: "-46.00",
    taxInclusive: "-246.00",
    payable: "-246.00",
  },
});

const rules = (result: { violations: readonly { rule: string }[] }) =>
  result.violations.map((v) => v.rule);

test("a credit note is a different document, not a different mapping", () => {
  const xml = toUBL(creditNote());

  assert.ok(
    xml.includes(`<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"`),
  );
  assert.ok(xml.includes("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>"));
  assert.ok(xml.includes(`<cbc:CreditedQuantity unitCode="C62">2</cbc:CreditedQuantity>`));
  assert.ok(xml.includes("<cac:CreditNoteLine>"));
  assert.ok(xml.trimEnd().endsWith("</CreditNote>"));
  for (const invoiceOnly of ["<cac:InvoiceLine>", "InvoicedQuantity", "InvoiceTypeCode"]) {
    assert.ok(!xml.includes(invoiceOnly), `the credit note carries ${invoiceOnly}`);
  }

  // The parties, the breakdown and the totals are the same elements as always.
  assert.ok(xml.includes("<cbc:CompanyID>PL5260250274</cbc:CompanyID>"));
  assert.ok(xml.includes(`<cbc:PayableAmount currencyID="EUR">246.00</cbc:PayableAmount>`));
  assert.ok(!/>-\d/.test(xml), "an amount was written with a minus sign");
});

test("the same rules run, and name the credit note's own elements", () => {
  const result = validate(creditNote());
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  for (const entry of result.coverage) {
    assert.ok(entry.path?.startsWith("/CreditNote"), `${entry.rule} at ${entry.at} points elsewhere`);
  }

  const wrong = validate(creditNote({ lines: [line("100.00", "250.00")] }));
  const violation = wrong.violations.find((v) => v.rule === "PEPPOL-EN16931-R120")!;
  assert.equal(violation.path, "/CreditNote/CreditNoteLine[1]/LineExtensionAmount");
});

// UBL carries BT-9 on an invoice only; the payment terms are the place to say it.
test("a credit note has no due date element", () => {
  const xml = toUBL(creditNote({ dueDate: "2026-09-20", paymentTerms: "Credited to the account" }));
  assert.ok(!xml.includes("<cbc:DueDate>"));
  assert.ok(xml.includes("<cbc:Note>Credited to the account</cbc:Note>"));
});

test("a refund is a type code, not a minus sign in front of the amounts", () => {
  const result = validate(negative);
  assert.equal(result.ok, false);
  assert.ok(rules(result).includes("BR-27"));

  const amounts = result.violations.filter((v) => v.rule === "INVOICERULES-CN-01");
  assert.deepEqual(
    amounts.map((v) => v.path),
    [
      "/Invoice/InvoiceLine[1]/LineExtensionAmount",
      "/Invoice/TaxTotal/TaxSubtotal[1]/TaxableAmount",
      "/Invoice/LegalMonetaryTotal/LineExtensionAmount",
      "/Invoice/LegalMonetaryTotal/TaxExclusiveAmount",
      "/Invoice/LegalMonetaryTotal/TaxInclusiveAmount",
    ],
  );
  assert.match(amounts[0].message, /a refund is a credit note \(type code 381\)/);
});

test("a credit note states what it credits as a positive amount too", () => {
  const result = validate({ ...negative, typeCode: "381" });
  const violation = result.violations.find((v) => v.rule === "INVOICERULES-CN-01")!;
  assert.match(violation.message, /a credit note states what it credits as a positive amount/);
  assert.equal(violation.path, "/CreditNote/CreditNoteLine[1]/LineExtensionAmount");
});

test("a negative allowance is refused where it is written", () => {
  const result = validate(
    creditNote({
      allowances: [{ amount: "-25.00", vatCategory: "S", vatRate: "23", reason: "Discount" }],
    }),
  );
  const violation = result.violations.find((v) => v.rule === "BR-31")!;
  assert.match(violation.message, /not a positive number/);
  assert.equal(violation.path, "/CreditNote/AllowanceCharge[1]/Amount");
});

test("the type code decides which document it is", () => {
  assert.ok(isCreditNote({ typeCode: "381" }));
  assert.ok(isCreditNote({ typeCode: "261" }));
  assert.ok(!isCreditNote({ typeCode: "380" }));
  assert.ok(!isCreditNote({ typeCode: "" }));
});
