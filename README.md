# invoicerules

Check an invoice against the EN 16931 business rules before a tax platform does.

From 2026 a rejected invoice stops being an email nobody answered and becomes a
document a government platform refuses. Belgium requires Peppol
[from January 2026](https://einvoice.belgium.be/en/article/structured-electronic-invoices-between-companies-are-compulsory-2026),
Poland's KSeF clears every invoice before it counts as delivered, and
[from September 2026](https://www.impots.gouv.fr/professionnel/questions/partir-de-quand-suis-je-concerne-par-la-reforme-de-la-facturation)
every business in France must be able to receive one. Under a clearance model an
invoice that fails validation was never issued — so failing at your own desk,
with a message naming the rule, beats failing at theirs.

```console
$ npm run demo
Valid: false
  BR-CO-09     /Invoice/AccountingSupplierParty/Party/PartyTaxScheme/CompanyID
               the seller's VAT identifier "5260250274" does not start with a country code
  BR-AE-10     /Invoice/TaxTotal/TaxSubtotal[1]/TaxCategory/TaxExemptionReason
               category AE charges no VAT but gives no exemption reason
  BR-CO-16     /Invoice/LegalMonetaryTotal/PayableAmount
               the amount due 330.00 does not match the total with VAT 300.00

Coverage: 27 checks, 24 passed, 3 failed
The totals, and every rule that looked at them:
  BR-CO-10     pass  /Invoice/LegalMonetaryTotal/LineExtensionAmount
  BR-CO-11     pass  /Invoice/LegalMonetaryTotal/AllowanceTotalAmount
  BR-CO-12     pass  /Invoice/LegalMonetaryTotal/ChargeTotalAmount
  BR-CO-13     pass  /Invoice/LegalMonetaryTotal/TaxExclusiveAmount
  BR-CO-14     pass  /Invoice/TaxTotal/TaxAmount
  BR-CO-15     pass  /Invoice/LegalMonetaryTotal/TaxInclusiveAmount
  BR-CO-16     fail  /Invoice/LegalMonetaryTotal/PayableAmount

Trying to write it as UBL anyway:
  refused, 3 fatal rule(s)

After fixing: valid = true
```

Those three are the mistakes that actually get made: a VAT number without its
country prefix, a reverse charge with no reason given, and a total that came
from a different invoice.

## Use

```ts
import { validate, toUBL } from "invoicerules";

const result = validate(invoice);
if (!result.ok) {
  for (const v of result.fatal) console.error(`${v.rule} at ${v.path ?? v.at}: ${v.message}`);
}

const xml = toUBL(invoice); // throws unless the rules pass
```

## A failure is a place, not a boolean

`validate` also returns a coverage report: every rule that was evaluated, how it
came out, and the element it looked at — named both as the model field and as
the path it has in the document that gets sent.

```ts
validate(invoice).coverage.find((c) => c.rule === "BR-CO-16");
// { rule: "BR-CO-16", outcome: "fail",
//   at: "totals.payable", path: "/Invoice/LegalMonetaryTotal/PayableAmount",
//   message: "the amount due 330.00 does not match the total with VAT 300.00" }
```

A rule that runs against several elements is reported against each of them, so a
line with no breakdown group is `/Invoice/InvoiceLine[3]/Item/ClassifiedTaxCategory/ID`
and not the invoice as a whole. A rule with nothing to check — there is no
seller VAT identifier to test the prefix of — is absent rather than counted as
passing, so the report says what was actually looked at.

## Why the rule identifiers are kept

`BR-CO-15` looks like noise until a platform rejects your invoice and quotes it
back at you. The identifiers here are the standard's own, so an error from this
library and an error from the receiving end name the same thing. Where EN 16931
leaves an arithmetic rule to the syntax binding rather than stating it itself —
the line net amount, an allowance percentage against its base amount — the
Peppol identifier is used, because that is the one a receiver will quote. The
wording of each message is this library's own; the normative text lives in
EN 16931-1, which is published by CEN and is not reproduced here.

The identifier is not always the category letter: the intra-community rules for
category K are named `BR-IC-01..12`, so that is what this library reports for a
K group, rather than a `BR-K-*` name the standard does not have.

Three checks are not the standard's: that a document states its amounts
positively and that a refund is issued as a credit note, that a due date is a
date on or after the issue date, and that an account identifier in IBAN shape
has check digits that hold. They are reported as `INVOICERULES-CN-01`,
`INVOICERULES-DUE-01` and `INVOICERULES-IBAN-01`, prefixed so they cannot be
mistaken for identifiers a receiver will quote back.

## Amounts are exact

Money is not a float. `0.1 + 0.2` is how a totals check fails on an invoice that
is perfectly correct, and rounding VAT in binary floating point produces the cent
of difference a validator rejects. Every amount is an integer and a scale, with
half-up rounding, and a one-cent rounding difference on a total is tolerated
because it is normal — two cents is not.

## The VAT breakdown is computed, not summarised

A breakdown group is not a summary of the lines. A document level discount
belongs to a category and a rate as well, and moves the taxable amount of that
group; an invoice that reports VAT on the undiscounted lines is consistent with
itself and still wrong.

```ts
import { computeVatBreakdown, reconcile } from "invoicerules";

computeVatBreakdown(invoice); // subtotals per category and rate, VAT rounded to the cent
reconcile(invoice);           // every arithmetic check, passing or not
```

`reconcile` returns each check with the rule it comes from (`BR-CO-13`) and the
business term it constrains (`BT-109`), so an amount can be shown with the rule
it answers to rather than only with what failed.

## A discount belongs somewhere

An allowance either belongs to the invoice or to one line, and the two travel
differently. A document level allowance (BG-20) carries its own VAT category and
rate, is summed into BT-107, and moves the taxable amount of the breakdown group
it names. A line level allowance (BG-27) carries no category — it follows the
line's — and reaches the totals only through the line net amount BT-131, which
is quantity × price, less the line's allowances and plus its charges.

```ts
const line = {
  id: "1", name: "Consulting", quantity: 10, netPrice: "20.00",
  netAmount: "185.00",                       // 200.00 - 20.00 + 5.00
  vatCategory: "S", vatRate: "23",
  allowances: [
    { amount: "20.00", baseAmount: "200.00", percentage: "10",
      reason: "Volume discount", reasonCode: "95" },
  ],
  charges: [{ amount: "5.00", reason: "Packaging" }],
};
```

Putting that discount into BT-107 as well counts it twice; leaving it out of
BT-131 hides it from the totals and the VAT breakdown both. Either way the
invoice adds up against itself and still fails at the platform, so both are
checked. So is a percentage against the base amount it claims to be a percentage
of: a receiver that recomputes one from the other has to arrive at the amount
the document states.

## Payment is a date, a party and an instruction

An invoice that adds up and cannot be paid is still a failure. Three things
decide whether it can be: when it is due (BT-9, or the terms in BT-20), who is
paid when that is not the seller (BG-10), and how (BG-16).

```ts
const payable = {
  ...invoice,
  dueDate: "2026-09-15",
  paymentTerms: "30 days net",
  payee: { name: "Factor SA", id: "PL9999999999" },
  paymentMeans: [
    { typeCode: "30", name: "Credit transfer", remittanceInformation: "FV-2026-0042",
      creditTransfer: { accountId: "PL61109010140000071219812874", bic: "WBKPPLPP" } },
  ],
};
```

The means code decides the rest. Every instruction needs one (BR-49) and one
that names an account has to give it (BR-50); once the code says credit transfer
— 30, 31 or 58 — the account the money goes to is required under BR-61, because
a credit transfer with no BT-84 is an invoice nobody can pay. A payee is named
beside the seller rather than in place of it, and naming one without a name
fails BR-17: the seller is who supplied, the payee is only who is paid.

Where the account identifier is in IBAN shape its check digits are verified. An
IBAN with a transposed pair is money that arrives somewhere else while the
document stays structurally perfect, and the mod 97-10 check costs nothing. A
national account number that is not in IBAN shape is left alone rather than
guessed at.

The document carries all of it where a receiver reads it: `PayeeParty`,
`PaymentMeans` with `PayeeFinancialAccount`, and `PaymentTerms/Note`.

### What a payment instruction is not checked for

Named rather than implied. A library that says "payment means supported" and
means half the rules is worse than one that lists the half it leaves out.

```ts
import { UNCHECKED_PAYMENT_RULES } from "invoicerules";
// each entry: { rule, about, note }
```

| | |
|---|---|
| `BR-CO-25` | a positive amount due needs a due date or payment terms — both are modelled and written, neither is required yet |
| `BR-51` | the last digits of a payment card number: payment card information (BG-18) is not modelled |
| `PEPPOL-EN16931-R061` | a direct debit needs a mandate reference: direct debit (BG-19) is not modelled |
| `UNCL4461` | the payment means code is required and read, and not checked against the code list |
| `ISO 13616` | an account identifier that is not in IBAN shape |

## A credit note is a type code, not a minus sign

A refund is a UBL CreditNote with a credit note type code (BT-3: 381, and the
rest of UNCL1001), and its amounts are stated positively — the document type
carries the direction. One mapping writes both documents and one rule set checks
both; the type code decides the root element, the line element and the quantity
element.

```ts
const creditNote = { ...invoice, id: "KOR-2026-0001", typeCode: "381" };

toUBL(creditNote); // <CreditNote>, CreditNoteLine, CreditedQuantity
```

The report follows the document: a line amount that does not add up is
`/CreditNote/CreditNoteLine[1]/LineExtensionAmount`, which is the path the
receiver will quote, not one into a document it never got.

An invoice with negative amounts is the same money booked twice by a receiver
that reads the sign instead of the code, so a negative line amount, taxable
amount or total is refused under `INVOICERULES-CN-01`, and a negative item net
price under BR-27. The payable amount is left alone: BT-115 is legitimately
negative when more was prepaid than was owed. UBL carries the payment due date
(BT-9) as a root element on an invoice only, so on a credit note it is written
inside the first payment instruction, as
`/CreditNote/PaymentMeans[1]/PaymentDueDate` — and a credit note with a due date
and no instruction at all is warned about rather than losing the date silently.

## The rule catalog

Every rule below runs on every document, invoice or credit note, and appears in
the coverage report whether it passes or not. The identifiers are the ones a
receiver quotes: `BR-*`, `BR-CO-*` and `BR-S-*` come from EN 16931-1, the
`PEPPOL-EN16931-R*` ones from the Peppol BIS Billing 3.0 rule list at
https://docs.peppol.eu/poacc/billing/3.0/rules/, and `INVOICERULES-*` is this
library's own. The second column is the business term the rule constrains, so a
model field, a rule and a BT number all name the same thing.

### Presence

| Rule | Term | What it checks |
|---|---|---|
| BR-01 | BT-1 | the invoice has a number |
| BR-02 | BT-2 | the issue date is present and is a date |
| BR-03 | BT-3 | the document type code is given |
| BR-04 | BT-5 | the currency is a three-letter ISO 4217 code |
| BR-06 | BT-27 | the seller has a name |
| BR-07 | BT-44 | the buyer has a name |
| BR-09 | BT-40 | the seller's country is an ISO 3166-1 alpha-2 code |
| BR-11 | BT-55 | the buyer's country is an ISO 3166-1 alpha-2 code |
| BR-12 | BT-106…BT-115 | the totals are all present and all numbers |
| BR-16 | BG-25 | the invoice has at least one line |
| BR-CO-09 | BT-31 | the seller's VAT identifier starts with a country code |

### Lines

| Rule | Term | What it checks |
|---|---|---|
| BR-21 | BT-126 | the line has an identifier |
| BR-25 | BT-153 | the line names what was sold |
| BR-CO-04 | BT-151 | the line has a VAT category |
| BR-27 | BT-146 | the item net price is not negative |
| PEPPOL-EN16931-R120 | BT-131 | the line net amount is quantity × price, less the line's allowances and plus its charges |

### Allowances and charges

| Rule | Term | What it checks |
|---|---|---|
| BR-31 / BR-36 | BT-92 / BT-99 | a document level allowance or charge has an amount, and it is positive |
| BR-32 / BR-37 | BT-95 / BT-102 | it names the VAT category it belongs to |
| BR-33 / BR-38 | BT-97 / BT-104 | it gives a reason or a reason code |
| BR-41 / BR-43 | BT-136 / BT-141 | a line level allowance or charge has an amount, and it is positive |
| BR-42 / BR-44 | BT-139 / BT-144 | it gives a reason or a reason code |
| PEPPOL-EN16931-R040 | BT-94 / BT-101 | the amount is the stated percentage of the stated base amount |
| PEPPOL-EN16931-R041 | BT-93 / BT-100 | a percentage comes with a base amount to apply it to |
| PEPPOL-EN16931-R042 | BT-94 / BT-101 | a base amount comes with a percentage of it |

### VAT breakdown

| Rule | Term | What it checks |
|---|---|---|
| BR-45 | BT-116 | the taxable amount of a group matches its lines, allowances and charges |
| BR-CO-17 | BT-117 | the VAT of a group is its rate applied to its taxable amount |
| BR-S-05 | BT-119 | a standard-rated group carries a rate above zero |
| BR-S-08 | BT-116 | a standard-rated group's taxable and tax amounts are numbers |
| BR-S-09 | BT-117 | the VAT of a standard-rated group, which is BR-CO-17 under the narrower name a validator reports |
| BR-Z-05, BR-E-05, BR-AE-05, BR-IC-05, BR-G-05, BR-O-05 | BT-119 | a group that charges no VAT carries a zero rate |
| BR-Z-10, BR-E-10, BR-AE-10, BR-IC-10, BR-G-10, BR-O-10 | BT-120 | it says why no VAT is charged |
| BR-CO-18 | BG-23 | every category and rate used on a line, an allowance or a charge has a group; two groups sharing one is a warning |

The intra-community category K is reported under `BR-IC-*`, which is the name
EN 16931 gives those rules and the one a receiver quotes.

### Totals

| Rule | Term | What it checks |
|---|---|---|
| BR-CO-10 | BT-106 | the line total is the sum of the line net amounts |
| BR-CO-11 | BT-107 | the allowance total is the sum of the document level allowances |
| BR-CO-12 | BT-108 | the charge total is the sum of the document level charges |
| BR-CO-13 | BT-109 | the total without VAT is the line total, less allowances, plus charges |
| BR-CO-14 | BT-110 | the VAT total is the sum of the breakdown |
| BR-CO-15 | BT-112 | the total with VAT is the total without VAT plus the VAT total |
| BR-CO-16 | BT-115 | the amount due is the total with VAT, less what was prepaid, plus rounding |

### Payment

| Rule | Term | What it checks |
|---|---|---|
| BR-17 | BT-59 | a payee named beside the seller has a name |
| BR-49 | BT-81 | every payment instruction gives a payment means code |
| BR-50 | BT-84 | an instruction that names an account gives its identifier |
| BR-61 | BT-84 | a credit transfer — code 30, 31 or 58 — gives the account the money goes to |

### Not the standard's

| Rule | Term | What it checks |
|---|---|---|
| INVOICERULES-CN-01 | BT-129, BT-131, BT-116, BT-106, BT-109, BT-112 | amounts are stated positively; a refund is a credit note, not an invoice with a minus sign |
| INVOICERULES-DUE-01 | BT-9 | the due date is a date, on or after the issue date, and has somewhere to be written |
| INVOICERULES-IBAN-01 | BT-84 | an account identifier in IBAN shape has check digits that hold |

## What is not checked

The catalog above is the whole of it. These are the things a reader might
reasonably expect from it and will not get — the payment instruction has its own
list, further up.

- **National rule extensions.** The Schematron a country layers on top of
  EN 16931 is not here: Poland's KSeF and its FA(3) format, Italy's FatturaPA,
  the French CTC rules, any national CIUS. A document that passes these checks
  can still be refused by a platform that applies its own.
- **Most of Peppol BIS Billing 3.0.** Four Peppol identifiers are implemented —
  R040, R041, R042 and R120 — because EN 16931 leaves that arithmetic to the
  syntax binding. The rest of the `PEPPOL-EN16931-R*` series is not: participant
  identifier schemes and endpoint identifiers, which document type codes a
  profile allows, the VATEX exemption reason code list, and the address and
  contact rules.
- **Code list membership.** The payment means code (BT-81) is read and not looked
  up in UNCL4461; the document type code (BT-3) is matched only against the
  UNCL1001 codes that make a document a credit note; the currency and country
  codes are checked for shape rather than against ISO 4217 and ISO 3166-1; a VAT
  category is constrained by the type in the model, not by a rule.
- **Anything outside the document.** Whether a VAT identifier is registered in
  VIES, whether the buyer can receive a Peppol document, whether the account in
  BT-84 belongs to the seller. Only the IBAN check digits are verified, and only
  where the identifier is in IBAN shape.
- **The XML against the UBL 2.1 schema.** The output is written to the shape the
  schema asks for; it is not validated against the XSD, which would mean a
  parser.
- **Rules about terms the model has no field for.** The reference to the invoice
  a credit note corrects (BG-3), the invoice period (BG-14), delivery (BG-13),
  the tax representative (BG-11), document references and attachments (BG-24),
  item classification and standard identifiers, payment card information (BG-18)
  and direct debit (BG-19). A rule that constrains one of those cannot fire.
- **A difference smaller than a cent.** The arithmetic tolerates one cent on a
  total, because rounding produces exactly that. Two is a failure.

## What it does not do

**It is not a mandate calendar.** `validate` takes an `Invoice` and nothing
else: no country, no date. So this library never decides whether a national
e-invoicing obligation applies to a document, or from when. The dates in the
opening paragraph are why these checks exist, not rules it evaluates. A passing
`Result` means the catalog's EN 16931 checks hold — not that a national mandate
such as KSeF's FA(3) format or the French CTC rules is met, which is the first
entry in "What is not checked" above.

**It is not a Peppol access point.** It writes the document; getting it to the
receiver is a different job, with registration and certificates attached.

**It does not read UBL.** Node has no XML parser in its standard library, so a
reader would mean either a dependency or a hand-rolled parser — and a hand-rolled
XML parser is a security bug with a release schedule. Missing, rather than
half-built.

**It is not tax advice.** Whether reverse charge applies to your supply is a
question for an accountant. This checks that the invoice you decided to issue is
internally consistent and structurally valid.

## Status

Early. The rules implemented are the ones that catch real rejections; the list
of what is missing is above rather than implied.

| | |
|---|---|
| Model | EN 16931 semantic terms: parties, lines, document and line level allowances and charges, VAT breakdown, totals, payee, payment means and terms |
| Rules | the catalog above: presence, lines, allowances and charges, the VAT breakdown, the totals, payment, and three checks of this library's own |
| Report | every rule evaluated, its outcome, and the element path it looked at |
| Output | UBL 2.1 Invoice or CreditNote with the Peppol BIS Billing 3.0 customization |
| Not yet | the reference to the invoice a credit note corrects (BG-3), payment card information (BG-18), direct debit (BG-19), CII and Factur-X syntax, KSeF's FA(3) format, national rule extensions, UBL reading |

## Install

Node 22.18 or newer, which runs the TypeScript sources directly. No runtime
dependencies.

```bash
npm install invoicerules
```

## Development

```bash
npm test        # node --test, no dependencies needed
npm run demo    # the transcript above
npm run typecheck   # needs: npm i -D typescript
```

## License

MIT

Maintained by [Shipmind Labs](https://shipmindlabs.com).
