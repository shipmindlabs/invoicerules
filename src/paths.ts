/**
 * Where a rule failed, said the way the receiving end says it.
 *
 * A validator on the other side quotes an XPath into the document it received:
 * /Invoice/InvoiceLine[3]/Price. The model here speaks in field names, so the
 * two name the same element in two vocabularies, and reconciling them by hand
 * is the slow part of fixing a rejection. Every outcome carries both.
 *
 * Indices are one-based, because that is what XPath counts. Allowances and
 * charges are two lists in the model and one in UBL, so a charge is found after
 * the allowances that precede it — at document level and within a line.
 */

const SUPPLIER = "/Invoice/AccountingSupplierParty/Party";
const CUSTOMER = "/Invoice/AccountingCustomerParty/Party";
const TOTALS = "/Invoice/LegalMonetaryTotal";

const FIXED: Record<string, string> = {
  id: "/Invoice/ID",
  issueDate: "/Invoice/IssueDate",
  dueDate: "/Invoice/DueDate",
  typeCode: "/Invoice/InvoiceTypeCode",
  currency: "/Invoice/DocumentCurrencyCode",
  paymentTerms: "/Invoice/PaymentTerms/Note",
  purchaseOrderReference: "/Invoice/OrderReference/ID",
  "seller.name": `${SUPPLIER}/PartyLegalEntity/RegistrationName`,
  "seller.address.countryCode": `${SUPPLIER}/PostalAddress/Country/IdentificationCode`,
  "seller.identification.vatId": `${SUPPLIER}/PartyTaxScheme/CompanyID`,
  "seller.identification.legalId": `${SUPPLIER}/PartyLegalEntity/CompanyID`,
  "buyer.name": `${CUSTOMER}/PartyLegalEntity/RegistrationName`,
  "buyer.address.countryCode": `${CUSTOMER}/PostalAddress/Country/IdentificationCode`,
  "buyer.identification.vatId": `${CUSTOMER}/PartyTaxScheme/CompanyID`,
  "buyer.identification.legalId": `${CUSTOMER}/PartyLegalEntity/CompanyID`,
  lines: "/Invoice/InvoiceLine",
  allowances: "/Invoice/AllowanceCharge",
  charges: "/Invoice/AllowanceCharge",
  vatBreakdown: "/Invoice/TaxTotal/TaxSubtotal",
  totals: TOTALS,
  "totals.lineTotal": `${TOTALS}/LineExtensionAmount`,
  "totals.allowanceTotal": `${TOTALS}/AllowanceTotalAmount`,
  "totals.chargeTotal": `${TOTALS}/ChargeTotalAmount`,
  "totals.taxExclusive": `${TOTALS}/TaxExclusiveAmount`,
  "totals.taxTotal": "/Invoice/TaxTotal/TaxAmount",
  "totals.taxInclusive": `${TOTALS}/TaxInclusiveAmount`,
  "totals.prepaid": `${TOTALS}/PrepaidAmount`,
  "totals.rounding": `${TOTALS}/PayableRoundingAmount`,
  "totals.payable": `${TOTALS}/PayableAmount`,
};

const LINE_FIELDS: Record<string, string> = {
  id: "/ID",
  name: "/Item/Name",
  quantity: "/InvoicedQuantity",
  netPrice: "/Price/PriceAmount",
  netAmount: "/LineExtensionAmount",
  vatCategory: "/Item/ClassifiedTaxCategory/ID",
  vatRate: "/Item/ClassifiedTaxCategory/Percent",
};

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

  const fixed = FIXED[at];
  if (fixed) return fixed;

  const { allowances = 0, lineAllowances = [] } =
    typeof context === "number" ? { allowances: context, lineAllowances: [] } : context;

  const withinLine = WITHIN_LINE.exec(at);
  if (withinLine) {
    const [, lineIndex, list, index, field] = withinLine;
    const before = list === "charges" ? lineAllowances[Number(lineIndex)] ?? 0 : 0;
    const base = `/Invoice/InvoiceLine[${Number(lineIndex) + 1}]/AllowanceCharge[${Number(index) + 1 + before}]`;
    return element(base, LINE_ADJUSTMENT_FIELDS, field);
  }

  const parsed = /^([a-zA-Z]+)\[(\d+)\](?:\.([a-zA-Z]+))?$/.exec(at);
  if (!parsed) return undefined;
  const [, collection, index, field] = parsed;
  const position = Number(index) + 1;

  switch (collection) {
    case "lines":
      return element(`/Invoice/InvoiceLine[${position}]`, LINE_FIELDS, field);
    case "vatBreakdown":
      return element(`/Invoice/TaxTotal/TaxSubtotal[${position}]`, SUBTOTAL_FIELDS, field);
    case "allowances":
      return element(`/Invoice/AllowanceCharge[${position}]`, ADJUSTMENT_FIELDS, field);
    case "charges":
      return element(`/Invoice/AllowanceCharge[${position + allowances}]`, ADJUSTMENT_FIELDS, field);
    default:
      return undefined;
  }
}

function element(base: string, fields: Record<string, string>, field: string | undefined): string {
  return field ? base + (fields[field] ?? "") : base;
}
