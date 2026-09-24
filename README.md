# invoicerules

Check an invoice against the EN 16931 business rules before a tax platform does.

From 2026 a rejected invoice stops being an email nobody answered and becomes a
document a government platform refuses. Belgium requires Peppol from January
2026, Poland's KSeF clears every invoice before it counts as delivered, and from
September 2026 every business in France must be able to receive one. Under a
clearance model an invoice that fails validation was never issued — so failing
at your own desk, with a message naming the rule, beats failing at theirs.

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

One check is not the standard's: that a document states its amounts positively
and that a refund is issued as a credit note. It is reported as
`INVOICERULES-CN-01`, prefixed so it cannot be mistaken for an identifier a
receiver will quote back.

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
(BT-9) on an invoice only, so a credit note written here has no DueDate element.

## What it does not do

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
of what is missing is below rather than implied.

| | |
|---|---|
| Model | EN 16931 semantic terms: parties, lines, document and line level allowances and charges, VAT breakdown, totals |
| Rules | presence (BR-01…BR-16), document level allowances and charges (BR-31…BR-38), line level ones (BR-41…BR-44), percentage against base amount (PEPPOL-EN16931-R040…R042), line net amount (PEPPOL-EN16931-R120), arithmetic (BR-CO-10…BR-CO-17), breakdown against the lines (BR-45), standard rate (BR-S-05/08/09), zero-VAT reasons (BR-Z/E/AE/K/G/O-10), VAT identifier prefix (BR-CO-09), breakdown coverage (BR-CO-18), item net price (BR-27), amounts stated positively (INVOICERULES-CN-01) |
| Report | every rule evaluated, its outcome, and the element path it looked at |
| Output | UBL 2.1 Invoice or CreditNote with the Peppol BIS Billing 3.0 customization |
| Not yet | the reference to the invoice a credit note corrects (BG-3), CII and Factur-X syntax, KSeF's FA(3) format, national rule extensions, UBL reading |

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
