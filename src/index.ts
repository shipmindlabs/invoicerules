/**
 * invoicerules — check an invoice against EN 16931 before a tax platform does,
 * and write it as UBL.
 *
 * Not a Peppol access point and not tax advice. See README.md.
 */

export type {
  Address,
  AllowanceCharge,
  Amount,
  Invoice,
  Line,
  Party,
  PartyIdentification,
  Totals,
  VatBreakdown,
  VatCategory,
} from "./model.ts";

export { Decimal, InvalidNumber, sum } from "./decimal.ts";

export { validate, type Result, type Severity, type Violation } from "./rules.ts";

export {
  computeVatBreakdown,
  reconcile,
  taxOf,
  type RuleCheck,
  type VatInput,
} from "./vat.ts";

export {
  InvalidInvoice,
  PEPPOL_BIS_3,
  PEPPOL_PROFILE,
  toUBL,
  type UblOptions,
} from "./ubl.ts";
