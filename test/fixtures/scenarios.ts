/**
 * The invoices the golden fixtures are recorded from.
 *
 * One per situation that writes a different document: a domestic sale with VAT
 * and a credit transfer to pay it, a cross-border supply reverse charged to the
 * buyer, a credit note whose due date has to travel inside the payment
 * instruction, and a sale with allowances and charges at both levels. Each is
 * an invoice that passes the rules, because a fixture of a document that could
 * not be issued records nothing anyone cares about.
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

const BUYER = {
  name: "Buyer Sp. z o.o.",
  address: { countryCode: "PL", city: "Krakow", postalCode: "30-001", line1: "Aleja 5" },
  identification: { vatId: "PL7770003699" },
} as const;

const ACCOUNT = { accountId: "PL61109010140000071219812874", bic: "WBKPPLPP" } as const;

const domestic: Invoice = {
  id: "FV-2026-0100",
  issueDate: "2026-08-16",
  dueDate: "2026-09-15",
  typeCode: "380",
  currency: "EUR",
  seller: SELLER,
  buyer: BUYER,
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
      creditTransfer: ACCOUNT,
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

// UBL has no DueDate element on a credit note, so BT-9 is written inside the
// first payment instruction; the recording is where that stays visible.
const creditNote: Invoice = {
  id: "KOR-2026-0001",
  issueDate: "2026-08-20",
  dueDate: "2026-09-19",
  typeCode: "381",
  currency: "EUR",
  seller: SELLER,
  buyer: BUYER,
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
  paymentMeans: [
    {
      typeCode: "30",
      name: "Credit transfer",
      remittanceInformation: "KOR-2026-0001",
      creditTransfer: ACCOUNT,
    },
  ],
  paymentTerms: "Credited to the account",
};

// The line level allowance and charge reach the totals only through BT-131; the
// document level ones carry a category and move the taxable amount of its group.
const allowance: Invoice = {
  id: "FV-2026-0102",
  issueDate: "2026-08-16",
  dueDate: "2026-09-15",
  typeCode: "380",
  currency: "EUR",
  seller: SELLER,
  buyer: BUYER,
  lines: [
    {
      id: "1",
      name: "Consulting",
      quantity: 10,
      netPrice: "20.00",
      netAmount: "185.00",
      vatCategory: "S",
      vatRate: "23",
      allowances: [
        {
          amount: "20.00",
          baseAmount: "200.00",
          percentage: "10",
          reason: "Volume discount",
          reasonCode: "95",
        },
      ],
      charges: [{ amount: "5.00", reason: "Packaging" }],
    },
  ],
  allowances: [
    {
      amount: "18.50",
      baseAmount: "185.00",
      percentage: "10",
      vatCategory: "S",
      vatRate: "23",
      reason: "Early settlement discount",
    },
  ],
  charges: [{ amount: "10.00", vatCategory: "S", vatRate: "23", reason: "Delivery" }],
  vatBreakdown: [{ category: "S", rate: "23", taxableAmount: "176.50", taxAmount: "40.60" }],
  totals: {
    lineTotal: "185.00",
    allowanceTotal: "18.50",
    chargeTotal: "10.00",
    taxExclusive: "176.50",
    taxTotal: "40.60",
    taxInclusive: "217.10",
    payable: "217.10",
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
  {
    name: "credit-note",
    about: "a credit note, its due date carried inside the payment instruction",
    invoice: creditNote,
  },
  {
    name: "allowance",
    about: "a sale with allowances and charges on the line and on the document",
    invoice: allowance,
  },
];
