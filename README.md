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
  BR-CO-09     seller.identification.vatId  the seller's VAT identifier "5260250274" does not start with a country code
  BR-AE-10     vatBreakdown[0]  category AE charges no VAT but gives no exemption reason
  BR-CO-16     totals.payable  the amount due 330.00 does not match the total with VAT 300.00

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
  for (const v of result.fatal) console.error(`${v.rule} at ${v.at}: ${v.message}`);
}

const xml = toUBL(invoice); // throws unless the rules pass
```

## Why the rule identifiers are kept

`BR-CO-15` looks like noise until a platform rejects your invoice and quotes it
back at you. The identifiers here are the standard's own, so an error from this
library and an error from the receiving end name the same thing. The wording of
each message is this library's own; the normative text lives in EN 16931-1,
which is published by CEN and is not reproduced here.

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
| Model | EN 16931 semantic terms: parties, lines, document level allowances and charges, VAT breakdown, totals |
| Rules | presence (BR-01…BR-16), allowances and charges (BR-31…BR-38), arithmetic (BR-CO-10…BR-CO-17), breakdown against the lines (BR-45), standard rate (BR-S-05/08/09), zero-VAT reasons (BR-Z/E/AE/K/G/O-10), VAT identifier prefix (BR-CO-09), breakdown coverage (BR-CO-18) |
| Output | UBL 2.1 with the Peppol BIS Billing 3.0 customization |
| Not yet | line level allowances and charges, credit notes, CII and Factur-X syntax, KSeF's FA(3) format, national rule extensions, UBL reading |

Line level allowances and charges are the remaining gap: a discount that belongs
to one line has to be folded into that line's net amount before it gets here.
That is a documented limit, not a silent one.

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
