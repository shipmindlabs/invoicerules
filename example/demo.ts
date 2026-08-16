/**
 * An invoice with three plausible mistakes in it, checked before it goes
 * anywhere, then fixed and written as UBL.
 *
 *   npm run demo
 */

import { InvalidInvoice, toUBL, validate, type Invoice } from "../src/index.ts";

// Three cross-border services at 100.00, reverse charged to a Dutch buyer.
const broken: Invoice = {
  id: "FV-2026-0042",
  issueDate: "2026-08-16",
  dueDate: "2026-09-15",
  typeCode: "380",
  currency: "EUR",
  seller: {
    name: "Seller Sp. z o.o.",
    address: { countryCode: "PL", city: "Warszawa", postalCode: "00-001", line1: "Ulica 1" },
    identification: { vatId: "5260250274" }, // mistake 1: no country prefix
  },
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
    // mistake 2: reverse charge with no reason given
    { category: "AE", rate: "0", taxableAmount: "300.00", taxAmount: "0.00" },
  ],
  totals: {
    lineTotal: "300.00",
    taxExclusive: "300.00",
    taxTotal: "0.00",
    taxInclusive: "300.00",
    payable: "330.00", // mistake 3: someone typed the gross of a different invoice
  },
};

const result = validate(broken);
console.log(`Valid: ${result.ok}`);
for (const violation of result.violations) {
  console.log(`  ${violation.rule.padEnd(12)} ${violation.at ?? "-"}  ${violation.message}`);
}

console.log("\nTrying to write it as UBL anyway:");
try {
  toUBL(broken);
} catch (error) {
  if (!(error instanceof InvalidInvoice)) throw error;
  console.log(`  refused, ${error.violations.length} fatal rule(s)`);
}

const fixed: Invoice = {
  ...broken,
  seller: { ...broken.seller, identification: { vatId: "PL5260250274" } },
  vatBreakdown: [
    {
      ...broken.vatBreakdown[0],
      exemptionReason: "Reverse charge",
      exemptionReasonCode: "VATEX-EU-AE",
    },
  ],
  totals: { ...broken.totals, payable: "300.00" },
};

console.log(`\nAfter fixing: valid = ${validate(fixed).ok}`);
console.log("\n" + toUBL(fixed).split("\n").slice(0, 22).join("\n"));
console.log("  …");
