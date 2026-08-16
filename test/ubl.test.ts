import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice } from "../src/model.ts";
import { InvalidInvoice, PEPPOL_BIS_3, toUBL } from "../src/ubl.ts";

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "FV-2026-0001",
    issueDate: "2026-08-16",
    typeCode: "380",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL", city: "Amsterdam" } },
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

test("the document carries what a receiver looks for first", () => {
  const xml = toUBL(invoice());

  assert.ok(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`));
  assert.ok(xml.includes(`<cbc:CustomizationID>${PEPPOL_BIS_3}</cbc:CustomizationID>`));
  assert.ok(xml.includes("<cbc:ID>FV-2026-0001</cbc:ID>"));
  assert.ok(xml.includes("<cbc:IssueDate>2026-08-16</cbc:IssueDate>"));
  assert.ok(xml.includes(`<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>`));
  assert.ok(xml.includes(`<cbc:PayableAmount currencyID="EUR">246.00</cbc:PayableAmount>`));
  assert.ok(xml.includes("<cbc:CompanyID>PL5260250274</cbc:CompanyID>"));
  assert.ok(xml.includes("<cbc:RegistrationName>Buyer BV</cbc:RegistrationName>"));
});

// Sending an invoice that fails validation into a clearance system means it was
// never issued. Finding that out from the tax platform costs a day.
test("an invoice that would be rejected is not written by default", () => {
  const broken = invoice({
    totals: {
      lineTotal: "200.00",
      taxExclusive: "200.00",
      taxTotal: "46.00",
      taxInclusive: "999.00",
      payable: "999.00",
    },
  });

  assert.throws(() => toUBL(broken), InvalidInvoice);
  try {
    toUBL(broken);
  } catch (error) {
    assert.match((error as Error).message, /BR-CO-15/);
  }

  // The escape hatch exists, and has to be asked for.
  assert.ok(toUBL(broken, { allowInvalid: true }).includes("999.00"));
});

// Every second law firm has an ampersand in its name.
test("text is escaped, so a company name cannot break the document", () => {
  const xml = toUBL(
    invoice({
      buyer: { name: `Smith & Sons <"Legal">`, address: { countryCode: "NL" } },
    }),
  );
  assert.ok(xml.includes("Smith &amp; Sons &lt;&quot;Legal&quot;&gt;"));
  assert.ok(!xml.includes("Smith & Sons"));
});

test("optional fields appear only when present", () => {
  const without = toUBL(invoice());
  assert.ok(!without.includes("<cbc:DueDate>"));
  assert.ok(!without.includes("<cac:OrderReference>"));
  assert.ok(!without.includes("<cac:PaymentTerms>"));

  const withThem = toUBL(
    invoice({ dueDate: "2026-09-15", purchaseOrderReference: "PO-77", paymentTerms: "30 days net" }),
  );
  assert.ok(withThem.includes("<cbc:DueDate>2026-09-15</cbc:DueDate>"));
  assert.ok(withThem.includes("<cbc:ID>PO-77</cbc:ID>"));
  assert.ok(withThem.includes("30 days net"));
});

test("an exemption reason reaches the tax category", () => {
  const xml = toUBL(
    invoice({
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
      vatBreakdown: [
        {
          category: "AE",
          rate: "0",
          taxableAmount: "200.00",
          taxAmount: "0.00",
          exemptionReason: "Reverse charge",
          exemptionReasonCode: "VATEX-EU-AE",
        },
      ],
      totals: {
        lineTotal: "200.00",
        taxExclusive: "200.00",
        taxTotal: "0.00",
        taxInclusive: "200.00",
        payable: "200.00",
      },
    }),
  );
  assert.ok(xml.includes("<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>"));
  assert.ok(xml.includes("<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>"));
});

test("every line becomes an InvoiceLine", () => {
  const twoLines = invoice({
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
      {
        id: "2",
        name: "Support",
        quantity: 1,
        netPrice: "100.00",
        netAmount: "100.00",
        vatCategory: "S",
        vatRate: "23",
      },
    ],
  });
  const xml = toUBL(twoLines);
  assert.equal(xml.match(/<cac:InvoiceLine>/g)?.length, 2);
  assert.ok(xml.includes("<cbc:Name>Support</cbc:Name>"));
});
