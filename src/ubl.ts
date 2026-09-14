/**
 * Writing the invoice as UBL 2.1, the syntax Peppol carries and Belgium
 * mandates from January 2026.
 *
 * Writing only. Reading UBL means an XML parser, and Node has none in its
 * standard library — so a reader would either drag in a dependency or ship a
 * hand-rolled parser, and a hand-rolled XML parser is a security bug with a
 * release schedule. It is listed as missing rather than half-built.
 */

import { validate } from "./rules.ts";
import type { AllowanceCharge, Invoice, LineAllowanceCharge, Party, VatBreakdown } from "./model.ts";

export class InvalidInvoice extends Error {
  readonly violations: readonly { rule: string; message: string }[];

  constructor(violations: readonly { rule: string; message: string }[]) {
    super(
      "the invoice does not satisfy EN 16931 and would be rejected:\n" +
        violations.map((v) => `  ${v.rule}: ${v.message}`).join("\n"),
    );
    this.violations = violations;
  }
}

/** The Peppol BIS Billing 3.0 customization, which is what most receivers expect. */
export const PEPPOL_BIS_3 =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PEPPOL_PROFILE = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

export type UblOptions = {
  readonly customizationId?: string;
  readonly profileId?: string;
  /**
   * Write the document even if the rules do not pass. Off by default: sending
   * an invoice that fails validation into a clearance system means it was never
   * issued, and finding that out from the tax platform costs a day.
   */
  readonly allowInvalid?: boolean;
};

export function toUBL(invoice: Invoice, options: UblOptions = {}): string {
  if (!options.allowInvalid) {
    const result = validate(invoice);
    if (!result.ok) throw new InvalidInvoice(result.fatal);
  }

  const currency = invoice.currency;
  const totals = invoice.totals;
  const adjustments = [
    ...(invoice.allowances ?? []).map((item) => allowanceCharge(item, false, currency, "  ")),
    ...(invoice.charges ?? []).map((item) => allowanceCharge(item, true, currency, "  ")),
  ];
  const lines = invoice.lines.map((line) => {
    const lineAdjustments = [
      ...(line.allowances ?? []).map((item) => allowanceCharge(item, false, currency, "    ")),
      ...(line.charges ?? []).map((item) => allowanceCharge(item, true, currency, "    ")),
    ];
    return `  <cac:InvoiceLine>
    <cbc:ID>${esc(line.id)}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${esc(String(line.quantity))}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${esc(currency)}">${esc(line.netAmount)}</cbc:LineExtensionAmount>
${lineAdjustments.length > 0 ? lineAdjustments.join("\n") + "\n" : ""}    <cac:Item>
      <cbc:Name>${esc(line.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${esc(line.vatCategory)}</cbc:ID>
        <cbc:Percent>${esc(line.vatRate)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${esc(currency)}">${esc(line.netPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${esc(options.customizationId ?? PEPPOL_BIS_3)}</cbc:CustomizationID>
  <cbc:ProfileID>${esc(options.profileId ?? PEPPOL_PROFILE)}</cbc:ProfileID>
  <cbc:ID>${esc(invoice.id)}</cbc:ID>
  <cbc:IssueDate>${esc(invoice.issueDate)}</cbc:IssueDate>
${invoice.dueDate ? `  <cbc:DueDate>${esc(invoice.dueDate)}</cbc:DueDate>\n` : ""}  <cbc:InvoiceTypeCode>${esc(invoice.typeCode)}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${esc(currency)}</cbc:DocumentCurrencyCode>
${invoice.purchaseOrderReference ? `  <cac:OrderReference><cbc:ID>${esc(invoice.purchaseOrderReference)}</cbc:ID></cac:OrderReference>\n` : ""}  <cac:AccountingSupplierParty>
${party(invoice.seller)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
${party(invoice.buyer)}
  </cac:AccountingCustomerParty>
${invoice.paymentTerms ? `  <cac:PaymentTerms><cbc:Note>${esc(invoice.paymentTerms)}</cbc:Note></cac:PaymentTerms>\n` : ""}${adjustments.length > 0 ? adjustments.join("\n") + "\n" : ""}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${esc(currency)}">${esc(totals.taxTotal)}</cbc:TaxAmount>
${invoice.vatBreakdown.map((group) => subtotal(group, currency)).join("\n")}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${esc(currency)}">${esc(totals.lineTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${esc(currency)}">${esc(totals.taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${esc(currency)}">${esc(totals.taxInclusive)}</cbc:TaxInclusiveAmount>
${totals.allowanceTotal ? `    <cbc:AllowanceTotalAmount currencyID="${esc(currency)}">${esc(totals.allowanceTotal)}</cbc:AllowanceTotalAmount>\n` : ""}${totals.chargeTotal ? `    <cbc:ChargeTotalAmount currencyID="${esc(currency)}">${esc(totals.chargeTotal)}</cbc:ChargeTotalAmount>\n` : ""}${totals.prepaid ? `    <cbc:PrepaidAmount currencyID="${esc(currency)}">${esc(totals.prepaid)}</cbc:PrepaidAmount>\n` : ""}${totals.rounding ? `    <cbc:PayableRoundingAmount currencyID="${esc(currency)}">${esc(totals.rounding)}</cbc:PayableRoundingAmount>\n` : ""}    <cbc:PayableAmount currencyID="${esc(currency)}">${esc(totals.payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines.join("\n")}
</Invoice>
`;
}

function party(party: Party): string {
  return `    <cac:Party>
${party.identification?.vatId ? `      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(party.identification.vatId)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>\n` : ""}      <cac:PostalAddress>
${party.address.line1 ? `        <cbc:StreetName>${esc(party.address.line1)}</cbc:StreetName>\n` : ""}${party.address.city ? `        <cbc:CityName>${esc(party.address.city)}</cbc:CityName>\n` : ""}${party.address.postalCode ? `        <cbc:PostalZone>${esc(party.address.postalCode)}</cbc:PostalZone>\n` : ""}        <cac:Country>
          <cbc:IdentificationCode>${esc(party.address.countryCode)}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(party.name)}</cbc:RegistrationName>
${party.identification?.legalId ? `        <cbc:CompanyID>${esc(party.identification.legalId)}</cbc:CompanyID>\n` : ""}      </cac:PartyLegalEntity>
    </cac:Party>`;
}

/**
 * One AllowanceCharge element. A line level one carries no TaxCategory: it
 * belongs to the line, which states the category once in its Item.
 */
function allowanceCharge(
  item: AllowanceCharge | LineAllowanceCharge,
  isCharge: boolean,
  currency: string,
  indent: string,
): string {
  const parts = [
    `${indent}<cac:AllowanceCharge>`,
    `${indent}  <cbc:ChargeIndicator>${isCharge}</cbc:ChargeIndicator>`,
  ];
  if (item.reasonCode) {
    parts.push(`${indent}  <cbc:AllowanceChargeReasonCode>${esc(item.reasonCode)}</cbc:AllowanceChargeReasonCode>`);
  }
  if (item.reason) {
    parts.push(`${indent}  <cbc:AllowanceChargeReason>${esc(item.reason)}</cbc:AllowanceChargeReason>`);
  }
  if (item.percentage) {
    parts.push(`${indent}  <cbc:MultiplierFactorNumeric>${esc(item.percentage)}</cbc:MultiplierFactorNumeric>`);
  }
  parts.push(`${indent}  <cbc:Amount currencyID="${esc(currency)}">${esc(item.amount)}</cbc:Amount>`);
  if (item.baseAmount) {
    parts.push(`${indent}  <cbc:BaseAmount currencyID="${esc(currency)}">${esc(item.baseAmount)}</cbc:BaseAmount>`);
  }
  if ("vatCategory" in item) {
    parts.push(
      `${indent}  <cac:TaxCategory>`,
      `${indent}    <cbc:ID>${esc(item.vatCategory)}</cbc:ID>`,
      `${indent}    <cbc:Percent>${esc(item.vatRate)}</cbc:Percent>`,
      `${indent}    <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>`,
      `${indent}  </cac:TaxCategory>`,
    );
  }
  parts.push(`${indent}</cac:AllowanceCharge>`);
  return parts.join("\n");
}

function subtotal(group: VatBreakdown, currency: string): string {
  return `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${esc(currency)}">${esc(group.taxableAmount)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${esc(currency)}">${esc(group.taxAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${esc(group.category)}</cbc:ID>
        <cbc:Percent>${esc(group.rate)}</cbc:Percent>
${group.exemptionReasonCode ? `        <cbc:TaxExemptionReasonCode>${esc(group.exemptionReasonCode)}</cbc:TaxExemptionReasonCode>\n` : ""}${group.exemptionReason ? `        <cbc:TaxExemptionReason>${esc(group.exemptionReason)}</cbc:TaxExemptionReason>\n` : ""}        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
}

/**
 * Escape text for XML. A company name containing "&" is not exotic — it is
 * every second law firm — and an unescaped one produces a document the receiver
 * cannot parse at all.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
