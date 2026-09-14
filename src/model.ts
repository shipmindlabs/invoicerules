/**
 * The EN 16931 semantic model, in the terms the standard uses.
 *
 * The names look bureaucratic on purpose. BT-112 is the taxable amount, and
 * calling it `taxableAmount` in one library and `totalNet` in the next is how
 * two systems that both "support EN 16931" fail to exchange an invoice. The
 * business term ids are what every validator, every tax authority and every
 * error message on the other side will speak, so they are kept.
 */

/** Money in a currency, held as a string to keep the decimal exact. */
export type Amount = string;

export type PartyIdentification = {
  /** BT-31 / BT-48: the VAT identifier, e.g. "PL5260250274". */
  readonly vatId?: string;
  /** BT-30 / BT-47: legal registration identifier. */
  readonly legalId?: string;
};

export type Address = {
  /** BT-40 / BT-55: ISO 3166-1 alpha-2. The one field a tax rule cannot do without. */
  readonly countryCode: string;
  readonly line1?: string;
  readonly city?: string;
  readonly postalCode?: string;
};

export type Party = {
  /** BT-27 / BT-44: the registered name. */
  readonly name: string;
  readonly address: Address;
  readonly identification?: PartyIdentification;
};

/**
 * UNCL5305 VAT category codes. The four that decide whether an invoice needs a
 * reason for charging no VAT.
 */
export type VatCategory =
  /** S — standard rate. */
  | "S"
  /** Z — zero rated. */
  | "Z"
  /** E — exempt from VAT. */
  | "E"
  /** AE — VAT reverse charge. */
  | "AE"
  /** K — intra-Community supply. */
  | "K"
  /** G — export outside the EU. */
  | "G"
  /** O — services outside scope of VAT. */
  | "O";

/**
 * BG-27 / BG-28: a line level allowance or charge. It carries no VAT category
 * of its own: it belongs to the line, follows the line's category and rate, and
 * is taken off or added on before the line net amount (BT-131) that the totals
 * and the VAT breakdown are built from.
 */
export type LineAllowanceCharge = {
  /** BT-136 / BT-141: the amount, always positive. */
  readonly amount: Amount;
  /** BT-137 / BT-142: the amount a percentage applies to. */
  readonly baseAmount?: Amount;
  /** BT-138 / BT-143: percentage of the base amount. */
  readonly percentage?: string;
  /** BT-139 / BT-144: why it is on the line. */
  readonly reason?: string;
  /** BT-140 / BT-145: the coded form of the same reason. */
  readonly reasonCode?: string;
};

export type Line = {
  /** BT-126: line identifier, unique within the invoice. */
  readonly id: string;
  /** BT-153: what was sold. */
  readonly name: string;
  /** BT-129: quantity. */
  readonly quantity: number;
  /** BT-146: net price of one item. */
  readonly netPrice: Amount;
  /** BT-131: line net amount, quantity × price less the line's allowances and plus its charges. */
  readonly netAmount: Amount;
  /** BT-151: VAT category for this line. */
  readonly vatCategory: VatCategory;
  /** BT-152: VAT rate as a percentage, e.g. "23". */
  readonly vatRate: string;
  /** BG-27: line level allowances. */
  readonly allowances?: readonly LineAllowanceCharge[];
  /** BG-28: line level charges. */
  readonly charges?: readonly LineAllowanceCharge[];
};

/**
 * BG-20 / BG-21: a document level allowance or charge. The amount is always
 * positive; which list it is in decides whether it is taken off or added on.
 * It carries a category and a rate because it belongs to a VAT breakdown
 * group, not to the invoice as a whole.
 */
export type AllowanceCharge = {
  /** BT-92 / BT-99: the amount. */
  readonly amount: Amount;
  /** BT-93 / BT-100: the amount a percentage applies to. */
  readonly baseAmount?: Amount;
  /** BT-94 / BT-101: percentage of the base amount. */
  readonly percentage?: string;
  /** BT-95 / BT-102: the VAT category it belongs to. */
  readonly vatCategory: VatCategory;
  /** BT-96 / BT-103: the VAT rate it belongs to. */
  readonly vatRate: string;
  /** BT-97 / BT-104: why it is on the invoice. */
  readonly reason?: string;
  /** BT-98 / BT-105: the coded form of the same reason. */
  readonly reasonCode?: string;
};

/** BG-23: one VAT breakdown group, per category and rate. */
export type VatBreakdown = {
  /** BT-118 */
  readonly category: VatCategory;
  /** BT-119: percentage. Absent only where the category has no rate. */
  readonly rate: string;
  /** BT-116: taxable amount for this category and rate. */
  readonly taxableAmount: Amount;
  /** BT-117: the VAT for that taxable amount. */
  readonly taxAmount: Amount;
  /** BT-120: why no VAT is charged. Required for Z, E, AE, K, G and O. */
  readonly exemptionReason?: string;
  /** BT-121: the coded form of the same reason. */
  readonly exemptionReasonCode?: string;
};

export type Totals = {
  /** BT-106: sum of line net amounts. */
  readonly lineTotal: Amount;
  /** BT-107: sum of document level allowances. */
  readonly allowanceTotal?: Amount;
  /** BT-108: sum of document level charges. */
  readonly chargeTotal?: Amount;
  /** BT-109: total without VAT. */
  readonly taxExclusive: Amount;
  /** BT-110: total VAT. */
  readonly taxTotal: Amount;
  /** BT-112: total with VAT. */
  readonly taxInclusive: Amount;
  /** BT-113: what has already been paid. */
  readonly prepaid?: Amount;
  /** BT-114: rounding applied to the amount due. */
  readonly rounding?: Amount;
  /** BT-115: what is actually owed. */
  readonly payable: Amount;
};

export type Invoice = {
  /** BT-1: invoice number. */
  readonly id: string;
  /** BT-2: issue date, ISO yyyy-mm-dd. */
  readonly issueDate: string;
  /** BT-9: due date. */
  readonly dueDate?: string;
  /** BT-3: UNCL1001 document type. 380 is a commercial invoice. */
  readonly typeCode: string;
  /** BT-5: ISO 4217 currency. */
  readonly currency: string;
  readonly seller: Party;
  readonly buyer: Party;
  readonly lines: readonly Line[];
  /** BG-20: document level allowances. */
  readonly allowances?: readonly AllowanceCharge[];
  /** BG-21: document level charges. */
  readonly charges?: readonly AllowanceCharge[];
  readonly vatBreakdown: readonly VatBreakdown[];
  readonly totals: Totals;
  /** BT-20: payment terms, in words. */
  readonly paymentTerms?: string;
  /** BT-13: the buyer's purchase order reference. */
  readonly purchaseOrderReference?: string;
};
