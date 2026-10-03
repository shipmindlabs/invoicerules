/**
 * The invoices the golden fixtures are recorded from.
 *
 * One per situation that writes a different document: a domestic sale with
 * VAT and a credit transfer to pay it, and a cross-border supply reverse
 * charged to the buyer. Each is an invoice that passes the rules, because a
 * fixture of a document that could not be issued records nothing anyone cares
 * about.
 */

import type { Invoice } from "../../src/model.ts";

export type Scenario = {
  /** The stem of the recorded files: <name>.xml and <name>.outcomes.txt. */
  readonly name: string;
  readonly about: string;
  readonly invoice: Invoice;
};

const SELLER = {
  name: "Seller Sp. z o.o.",
  address: { countryCode: "PL", city: "Warszawa", postalCode: "00-001", line1: "Ulica 1" },
  identification: { vatId: "PL5260250274" },
} as const;

const domestic: Invoice = {
  id: "FV-2026-0100",
  issueDate: "2026-08-16",
  dueDate: "2026-09-15",
  typeCode: "380",
  currency: "EUR",
  seller: SELLER,
  buyer: {
    name: "Buyer Sp. z o.o.",
    address: { countryCode: "PL", city: "Krakow", postalCode: "30-001", line1: "Aleja 5" },
    identification: { vatId: "PL7770003699" },
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
  paymentMeans: [
    {
      typeCode: "30",
      name: "Credit transfer",
      remittanceInformation: "FV-2026-0100",
      creditTransfer: { accountId: "PL61109010140000071219812874", bic: "WBKPPLPP" },
    },
  ],
  paymentTerms: "30 days net",
};

const reverseCharge: Invoice = {
  id: "FV-2026-0101",
  issueDate: "2026-08-16",
  dueDate: "2026-09-15",
  typeCode: "380",
  currency: "EUR",
  seller: SELLER,
  buyer: {
    name: "Buyer & Partners BV",
    address: { countryCode: "NL", city: "Amsterdam", postalCode: "1011", line1: "Straat 2" },
    identification: { vatId: "NL123456789B01" },
  },
  lines: [
    {
      id: "1",
      name: "Consulting",
      quantity: 3,
      netPrice: "100.00",
      netAmount: "300.00",
      vatCategory: "AE",
      vatRate: "0",
    },
  ],
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
  totals: {
    lineTotal: "300.00",
    taxExclusive: "300.00",
    taxTotal: "0.00",
    taxInclusive: "300.00",
    payable: "300.00",
  },
  paymentTerms: "30 days net",
};

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "domestic",
    about: "a domestic sale at the standard rate, paid by credit transfer",
    invoice: domestic,
  },
  {
    name: "reverse-charge",
    about: "a cross-border service reverse charged to the buyer, with its exemption reason",
    invoice: reverseCharge,
  },
];
