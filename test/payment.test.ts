import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice } from "../src/model.ts";
import { UNCHECKED_PAYMENT_RULES, validate } from "../src/rules.ts";
import { toUBL } from "../src/ubl.ts";

const IBAN = "PL61109010140000071219812874";

/** 2 × 100.00 at 23%, due in 30 days, paid by credit transfer. */
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "FV-2026-0005",
    issueDate: "2026-08-16",
    dueDate: "2026-09-15",
    typeCode: "380",
    currency: "EUR",
    seller: {
      name: "Seller Sp. z o.o.",
      address: { countryCode: "PL", city: "Warszawa" },
      identification: { vatId: "PL5260250274" },
    },
    buyer: { name: "Buyer BV", address: { countryCode: "NL", city: "Amsterdam" } },
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
    paymentTerms: "30 days net",
    paymentMeans: [
      {
        typeCode: "30",
        name: "Credit transfer",
        remittanceInformation: "FV-2026-0005",
        creditTransfer: { accountId: IBAN, accountName: "Seller Sp. z o.o.", bic: "WBKPPLPP" },
      },
    ],
    ...overrides,
  };
}

const rules = (result: { violations: readonly { rule: string }[] }) =>
  result.violations.map((v) => v.rule);

test("a payable invoice passes, and each payment rule names its element", () => {
  const result = validate(invoice());
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));

  const byRule = new Map(result.coverage.map((entry) => [entry.rule, entry]));
  assert.equal(byRule.get("BR-49")?.path, "/Invoice/PaymentMeans[1]/PaymentMeansCode");
  assert.equal(byRule.get("BR-50")?.path, "/Invoice/PaymentMeans[1]/PayeeFinancialAccount/ID");
  assert.equal(byRule.get("BR-61")?.path, "/Invoice/PaymentMeans[1]/PayeeFinancialAccount/ID");
  assert.equal(byRule.get("INVOICERULES-DUE-01")?.path, "/Invoice/DueDate");
});

test("a due date is a date, and not before the invoice was issued", () => {
  const notADate = validate(invoice({ dueDate: "15/09/2026" }));
  const malformed = notADate.violations.find((v) => v.rule === "INVOICERULES-DUE-01")!;
  assert.match(malformed.message, /is not a date/);
  assert.equal(malformed.path, "/Invoice/DueDate");

  const backwards = validate(invoice({ dueDate: "2026-08-15" }));
  assert.match(
    backwards.violations.find((v) => v.rule === "INVOICERULES-DUE-01")!.message,
    /before the issue date 2026-08-16/,
  );

  // No due date is not a failure, and not a check that claims to have run.
  const without = validate(invoice({ dueDate: undefined }));
  assert.equal(without.ok, true);
  assert.ok(!without.coverage.some((entry) => entry.rule === "INVOICERULES-DUE-01"));
});

// UBL keeps a credit note's BT-9 inside the payment instruction, so with no
// instruction the date has nowhere to go.
test("a credit note with no payment instruction cannot carry its due date", () => {
  const result = validate(invoice({ typeCode: "381", paymentMeans: undefined }));
  const warning = result.warnings.find((w) => w.rule === "INVOICERULES-DUE-01")!;
  assert.match(warning.message, /inside a payment instruction/);
  assert.equal(warning.path, "/CreditNote/PaymentMeans[1]/PaymentDueDate");
  assert.equal(result.ok, true);

  const withOne = validate(invoice({ typeCode: "381" }));
  assert.ok(!withOne.warnings.some((w) => w.rule === "INVOICERULES-DUE-01"));
});

test("a payee that is not the seller has to be named", () => {
  const result = validate(invoice({ payee: { name: "  ", id: "PL9999999999" } }));
  const violation = result.violations.find((v) => v.rule === "BR-17")!;
  assert.equal(violation.path, "/Invoice/PayeeParty/PartyName/Name");

  assert.equal(validate(invoice({ payee: { name: "Factor SA" } })).ok, true);
  // No payee at all is the normal case, and BR-17 has nothing to say about it.
  assert.ok(!validate(invoice()).coverage.some((entry) => entry.rule === "BR-17"));
});

test("the means code is required, and a credit transfer needs an account", () => {
  const noCode = validate(invoice({ paymentMeans: [{ typeCode: "" }] }));
  assert.ok(rules(noCode).includes("BR-49"));

  const noAccount = validate(invoice({ paymentMeans: [{ typeCode: "30" }] }));
  const violation = noAccount.violations.find((v) => v.rule === "BR-61")!;
  assert.match(violation.message, /payment means 30 is a credit transfer/);
  assert.equal(violation.path, "/Invoice/PaymentMeans[1]/PayeeFinancialAccount/ID");

  const emptyAccount = validate(
    invoice({ paymentMeans: [{ typeCode: "48", creditTransfer: { accountId: " " } }] }),
  );
  assert.ok(rules(emptyAccount).includes("BR-50"));

  // 48 is a card payment: an account block is not required for it.
  assert.equal(validate(invoice({ paymentMeans: [{ typeCode: "48" }] })).ok, true);
});

// An IBAN with a transposed pair is money that arrives somewhere else while the
// document stays structurally perfect.
test("an account in IBAN shape has its check digits verified", () => {
  assert.ok(
    validate(invoice()).coverage.some(
      (entry) => entry.rule === "INVOICERULES-IBAN-01" && entry.outcome === "pass",
    ),
  );

  const transposed = IBAN.slice(0, -2) + "47";
  const result = validate(
    invoice({ paymentMeans: [{ typeCode: "30", creditTransfer: { accountId: transposed } }] }),
  );
  const violation = result.violations.find((v) => v.rule === "INVOICERULES-IBAN-01")!;
  assert.match(violation.message, /check digits do not hold/);
  assert.equal(violation.path, "/Invoice/PaymentMeans[1]/PayeeFinancialAccount/ID");
});

test("spaces and lower case do not make an IBAN wrong", () => {
  const spaced = "pl61 1090 1014 0000 0712 1981 2874";
  const result = validate(
    invoice({ paymentMeans: [{ typeCode: "30", creditTransfer: { accountId: spaced } }] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
});

test("a national account number is left alone rather than guessed at", () => {
  const result = validate(
    invoice({ paymentMeans: [{ typeCode: "30", creditTransfer: { accountId: "0123456789" } }] }),
  );
  assert.equal(result.ok, true);
  assert.ok(!result.coverage.some((entry) => entry.rule === "INVOICERULES-IBAN-01"));
});

test("what a payment instruction is not checked for is listed, not implied", () => {
  const named = UNCHECKED_PAYMENT_RULES.map((entry) => entry.rule);
  assert.equal(new Set(named).size, named.length);
  for (const rule of ["BR-CO-25", "BR-51", "PEPPOL-EN16931-R061", "UNCL4461", "ISO 13616"]) {
    assert.ok(named.includes(rule), `${rule} is not listed`);
  }
  for (const entry of UNCHECKED_PAYMENT_RULES) {
    assert.ok(entry.about.trim().length > 0 && entry.note.trim().length > 0, entry.rule);
  }

  // And nothing on the list is quietly evaluated after all.
  const evaluated = validate(invoice()).coverage.map((entry) => entry.rule);
  for (const rule of named) assert.ok(!evaluated.includes(rule), `${rule} is listed as unchecked`);
});

test("the document carries the payee, the instruction and the terms, in order", () => {
  const xml = toUBL(
    invoice({ payee: { name: "Factor SA", id: "PL9999999999", legalId: "0000123456" } }),
  );

  assert.ok(xml.includes("<cbc:DueDate>2026-09-15</cbc:DueDate>"));
  assert.ok(xml.includes("<cbc:Name>Factor SA</cbc:Name>"));
  assert.ok(xml.includes("<cbc:CompanyID>0000123456</cbc:CompanyID>"));
  assert.ok(xml.includes(`<cbc:PaymentMeansCode name="Credit transfer">30</cbc:PaymentMeansCode>`));
  assert.ok(xml.includes("<cbc:PaymentID>FV-2026-0005</cbc:PaymentID>"));
  assert.ok(xml.includes(`<cbc:ID>${IBAN}</cbc:ID>`));
  assert.ok(xml.includes("<cbc:ID>WBKPPLPP</cbc:ID>"));
  assert.ok(xml.includes("<cbc:Note>30 days net</cbc:Note>"));
  // An invoice states BT-9 at the root, so it is not repeated here.
  assert.ok(!xml.includes("<cbc:PaymentDueDate>"));

  const order = [
    "<cac:AccountingCustomerParty>",
    "<cac:PayeeParty>",
    "<cac:PaymentMeans>",
    "<cac:PaymentTerms>",
    "<cac:TaxTotal>",
  ].map((element) => xml.indexOf(element));
  assert.ok(order.every((index) => index > 0), "an element is missing");
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test("a credit note writes its due date inside the first payment instruction", () => {
  const xml = toUBL(
    invoice({
      typeCode: "381",
      paymentMeans: [
        { typeCode: "30", creditTransfer: { accountId: IBAN } },
        { typeCode: "31", creditTransfer: { accountId: "DE89370400440532013000" } },
      ],
    }),
  );

  assert.ok(!xml.includes("<cbc:DueDate>"));
  assert.equal(xml.match(/<cbc:PaymentDueDate>/g)?.length, 1);
  assert.ok(xml.includes("<cbc:PaymentDueDate>2026-09-15</cbc:PaymentDueDate>"));
  assert.ok(xml.indexOf("<cbc:PaymentDueDate>") < xml.indexOf("DE89370400440532013000"));
});

test("an instruction with only a code is still a complete element", () => {
  const xml = toUBL(invoice({ paymentMeans: [{ typeCode: "48" }] }));
  assert.ok(xml.includes("<cbc:PaymentMeansCode>48</cbc:PaymentMeansCode>"));
  assert.ok(!xml.includes("<cac:PayeeFinancialAccount>"));
  assert.ok(!xml.includes("<cac:PayeeParty>"));
});
