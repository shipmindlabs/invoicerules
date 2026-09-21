/**
 * Where a rule failed, said the way the receiving end says it, and which of the
 * two UBL documents it is said in.
 *
 * A validator on the other side quotes an XPath into the document it received:
 * /Invoice/InvoiceLine[3]/Price. The model here speaks in field names, so the
 * two name the same element in two vocabularies, and reconciling them by hand
 * is the slow part of fixing a rejection. Every outcome carries both.
 *
 * Which document it is matters. The same model issued as a credit note is
 * /CreditNote/CreditNoteLine[3]/Price, and a path into a document the receiver
 * never got is no better than no path at all. The document type code (BT-3)
 * decides, which is also what decides the syntax written in ubl.ts.
 *
 * Indices are one-based, because that is what XPath counts. Allowances and
 * charges are two lists in the model and one in UBL, so a charge is found after
 * the allowances that precede it — at document level and within a line.
 */

import type { Invoice } from "./model.ts";

/**
 * UNCL1001 codes that make the document a credit note rather than an invoice.
 * A refund is this code, not a minus sign in front of the amounts.
 */
export const CREDIT_NOTE_TYPE_CODES: ReadonlySet<string> = new Set([
  "81",
  "83",
  "261",
  "262",
  "296",
  "308",
  "381",
  "396",
  "532",
]);

export function isCreditNote(document: Pick<Invoice, "typeCode">): boolean {
  return CREDIT_NOTE_TYPE_CODES.has(document?.typeCode?.trim() ?? "");
}

/** The element names EN 16931 is bound to in each of the two UBL documents. */
export type Syntax = {
  readonly root: string;
  readonly namespace: string;
  readonly line: string;
  readonly typeCode: string;
  readonly quantity: string;
  /** Absent on a credit note: UBL carries BT-9 on an invoice only. */
  readonly dueDate?: string;
};

export const INVOICE_SYNTAX: Syntax = {
  root: "Invoice",
  namespace: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  line: "InvoiceLine",
  typeCode: "InvoiceTypeCode",
  quantity: "InvoicedQuantity",
  dueDate: "DueDate",
};

export const CREDIT_NOTE_SYNTAX: Syntax = {
  root: "CreditNote",
  namespace: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  line: "CreditNoteLine",
  typeCode: "CreditNoteTypeCode",
  quantity: "CreditedQuantity",
};

export function syntaxFor(document: Pick<Invoice, "typeCode">): Syntax {
  return isCreditNote(document) ? CREDIT_NOTE_SYNTAX : INVOICE_SYNTAX;
}

type Tables = {
  readonly fixed: Record<string, string>;
  readonly line: Record<string, string>;
};

function tables(syntax: Syntax): Tables {
  const root = `/${syntax.root}`;
  const supplier = `${root}/AccountingSupplierParty/Party`;
  const customer = `${root}/AccountingCustomerParty/Party`;
  const totals = `${root}/LegalMonetaryTotal`;

  return {
    fixed: {
      id: `${root}/ID`,
      issueDate: `${root}/IssueDate`,
      ...(syntax.dueDate ? { dueDate: `${root}/${syntax.dueDate}` } : {}),
      typeCode: `${root}/${syntax.typeCode}`,
      currency: `${root}/DocumentCurrencyCode`,
      paymentTerms: `${root}/PaymentTerms/Note`,
      purchaseOrderReference: `${root}/OrderReference/ID`,
      "seller.name": `${supplier}/PartyLegalEntity/RegistrationName`,
      "seller.address.countryCode": `${supplier}/PostalAddress/Country/IdentificationCode`,
      "seller.identification.vatId": `${supplier}/PartyTaxScheme/CompanyID`,
      "seller.identification.legalId": `${supplier}/PartyLegalEntity/CompanyID`,
      "buyer.name": `${customer}/PartyLegalEntity/RegistrationName`,
      "buyer.address.countryCode": `${customer}/PostalAddress/Country/IdentificationCode`,
      "buyer.identification.vatId": `${customer}/PartyTaxScheme/CompanyID`,
      "buyer.identification.legalId": `${customer}/PartyLegalEntity/CompanyID`,
      lines: `${root}/${syntax.line}`,
      allowances: `${root}/AllowanceCharge`,
      charges: `${root}/AllowanceCharge`,
      vatBreakdown: `${root}/TaxTotal/TaxSubtotal`,
      totals,
      "totals.lineTotal": `${totals}/LineExtensionAmount`,
      "totals.allowanceTotal": `${totals}/AllowanceTotalAmount`,
      "totals.chargeTotal": `${totals}/ChargeTotalAmount`,
      "totals.taxExclusive": `${totals}/TaxExclusiveAmount`,
      "totals.taxTotal": `${root}/TaxTotal/TaxAmount`,
      "totals.taxInclusive": `${totals}/TaxInclusiveAmount`,
      "totals.prepaid": `${totals}/PrepaidAmount`,
      "totals.rounding": `${totals}/PayableRoundingAmount`,
      "totals.payable": `${totals}/PayableAmount`,
    },
    line: {
      id: "/ID",
      name: "/Item/Name",
      quantity: `/${syntax.quantity}`,
      netPrice: "/Price/PriceAmount",
      netAmount: "/LineExtensionAmount",
      vatCategory: "/Item/ClassifiedTaxCategory/ID",
      vatRate: "/Item/ClassifiedTaxCategory/Percent",
    },
  };
}

const INVOICE_TABLES = tables(INVOICE_SYNTAX);
const CREDIT_NOTE_TABLES = tables(CREDIT_NOTE_SYNTAX);

const SUBTOTAL_FIELDS: Record<string, string> = {
  category: "/TaxCategory/ID",
  rate: "/TaxCategory/Percent",
  taxableAmount: "/TaxableAmount",
  taxAmount: "/TaxAmount",
  exemptionReason: "/TaxCategory/TaxExemptionReason",
  exemptionReasonCode: "/TaxCategory/TaxExemptionReasonCode",
};

const ADJUSTMENT_FIELDS: Record<string, string> = {
  amount: "/Amount",
  baseAmount: "/BaseAmount",
  percentage: "/MultiplierFactorNumeric",
  vatCategory: "/TaxCategory/ID",
  vatRate: "/TaxCategory/Percent",
  reason: "/AllowanceChargeReason",
  reasonCode: "/AllowanceChargeReasonCode",
};

/** A line level allowance has no tax category of its own; the line carries it. */
const LINE_ADJUSTMENT_FIELDS: Record<string, string> = {
  amount: "/Amount",
  baseAmount: "/BaseAmount",
  percentage: "/MultiplierFactorNumeric",
  reason: "/AllowanceChargeReason",
  reasonCode: "/AllowanceChargeReasonCode",
};

/** What is needed to count two model lists into the one list UBL writes. */
export type PathContext = {
  /** How many document level allowances precede the document level charges. */
  readonly allowances?: number;
  /** How many allowances each line carries, in line order. */
  readonly lineAllowances?: readonly number[];
  /** Which document the paths point into. */
  readonly creditNote?: boolean;
};

const WITHIN_LINE = /^lines\[(\d+)\]\.(allowances|charges)\[(\d+)\](?:\.([a-zA-Z]+))?$/;

/**
 * The UBL element a model location points at: "lines[2].netPrice" becomes
 * "/Invoice/InvoiceLine[3]/Price/PriceAmount". Nothing when the location has no
 * element of its own in the document.
 */
export function ublPath(
  at: string | undefined,
  context: number | PathContext = 0,
): string | undefined {
  if (!at) return undefined;

  const { allowances = 0, lineAllowances = [], creditNote = false } =
    typeof context === "number"
      ? { allowances: context, lineAllowances: [], creditNote: false }
      : context;

  const syntax = creditNote ? CREDIT_NOTE_SYNTAX : INVOICE_SYNTAX;
  const { fixed, line } = creditNote ? CREDIT_NOTE_TABLES : INVOICE_TABLES;
  const root = `/${syntax.root}`;

  const known = fixed[at];
  if (known) return known;

  const withinLine = WITHIN_LINE.exec(at);
  if (withinLine) {
    const [, lineIndex, list, index, field] = withinLine;
    const before = list === "charges" ? lineAllowances[Number(lineIndex)] ?? 0 : 0;
    const base = `${root}/${syntax.line}[${Number(lineIndex) + 1}]/AllowanceCharge[${Number(index) + 1 + before}]`;
    return element(base, LINE_ADJUSTMENT_FIELDS, field);
  }

  const parsed = /^([a-zA-Z]+)\[(\d+)\](?:\.([a-zA-Z]+))?$/.exec(at);
  if (!parsed) return undefined;
  const [, collection, index, field] = parsed;
  const position = Number(index) + 1;

  switch (collection) {
    case "lines":
      return element(`${root}/${syntax.line}[${position}]`, line, field);
    case "vatBreakdown":
      return element(`${root}/TaxTotal/TaxSubtotal[${position}]`, SUBTOTAL_FIELDS, field);
    case "allowances":
      return element(`${root}/AllowanceCharge[${position}]`, ADJUSTMENT_FIELDS, field);
    case "charges":
      return element(`${root}/AllowanceCharge[${position + allowances}]`, ADJUSTMENT_FIELDS, field);
    default:
      return undefined;
  }
}

function element(base: string, fields: Record<string, string>, field: string | undefined): string {
  return field ? base + (fields[field] ?? "") : base;
}
