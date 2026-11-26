import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice } from "../src/model.ts";
import { validate } from "../src/rules.ts";
import { toUBL } from "../src/ubl.ts";

/** A correct credit note: 100.00 at 23% VAT, credited back. */
function creditNote(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "KOR-2026-0001",
    issueDate: "2026-09-01",
    typeCode: "381",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL" } },
    lines: [
      {
        id: "1",
        name: "Consulting",
        quantity: 1,
        netPrice: "100.00",
        netAmount: "100.00",
        vatCategory: "S",
        vatRate: "23",
      },
    ],
    vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "100.00", taxAmount: "23.00" }],
    totals: {
      lineTotal: "100.00",
      taxExclusive: "100.00",
      taxTotal: "23.00",
      taxInclusive: "123.00",
      payable: "123.00",
    },
    ...overrides,
  };
}

const REFERENCE = `  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>FV-2026-0042</cbc:ID>
      <cbc:IssueDate>2026-08-16</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`;

// What a credit note credits is the one thing a receiver needs to match it back.
test("the invoice a credit note credits is written where a receiver reads it", () => {
  const xml = toUBL(
    creditNote({ precedingInvoices: [{ id: "FV-2026-0042", issueDate: "2026-08-16" }] }),
  );

  assert.ok(xml.includes(REFERENCE), xml);
  assert.ok(xml.indexOf("<cac:BillingReference>") < xml.indexOf("<cac:AccountingSupplierParty>"));
});

test("the date of the referenced invoice is optional", () => {
  const xml = toUBL(creditNote({ precedingInvoices: [{ id: "FV-2026-0042" }] }));

  assert.ok(xml.includes("<cbc:ID>FV-2026-0042</cbc:ID>"));
  assert.ok(!xml.includes("<cbc:IssueDate>2026-08-16</cbc:IssueDate>"));
});

test("several referenced invoices keep the order they were given in", () => {
  const xml = toUBL(creditNote({ precedingInvoices: [{ id: "FV-1" }, { id: "FV-2" }] }));

  assert.equal(xml.split("<cac:BillingReference>").length - 1, 2);
  assert.ok(xml.indexOf("FV-1") < xml.indexOf("FV-2"));
});

test("a document that refers back to nothing writes no reference", () => {
  const plain = creditNote();

  assert.ok(validate(plain).ok);
  assert.ok(!toUBL(plain).includes("BillingReference"));
});
