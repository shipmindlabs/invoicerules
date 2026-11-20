import { test } from "node:test";
import assert from "node:assert/strict";

import type { Invoice } from "../src/model.ts";
import { ublPath } from "../src/paths.ts";
import { UNCHECKED_PAYMENT_RULES, validate, type Result } from "../src/rules.ts";
import { InvalidInvoice, toUBL } from "../src/ubl.ts";

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

const entries = (result: Result, rule: string) =>
  result.coverage.filter((entry) => entry.rule === rule);

const outcomes = (result: Result, rule: string) => entries(result, rule).map((e) => e.outcome);

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

test("a payment element is named in whichever document carries it", () => {
  assert.equal(ublPath("paymentMeans"), "/Invoice/PaymentMeans");
  assert.equal(ublPath("paymentMeans[0]"), "/Invoice/PaymentMeans[1]");
  assert.equal(ublPath("paymentMeans[1].name"), "/Invoice/PaymentMeans[2]/PaymentMeansCode/@name");
  assert.equal(
    ublPath("paymentMeans[0].creditTransfer.bic"),
    "/Invoice/PaymentMeans[1]/PayeeFinancialAccount/FinancialInstitutionBranch/ID",
  );
  assert.equal(ublPath("paymentTerms"), "/Invoice/PaymentTerms/Note");
  assert.equal(ublPath("payee"), "/Invoice/PayeeParty");
  assert.equal(ublPath("payee.legalId"), "/Invoice/PayeeParty/PartyLegalEntity/CompanyID");

  // BT-9 is the one model field with two elements, and the document decides.
  assert.equal(ublPath("dueDate"), "/Invoice/DueDate");
  assert.equal(
    ublPath("dueDate", { creditNote: true }),
    "/CreditNote/PaymentMeans[1]/PaymentDueDate",
  );
  assert.equal(
    ublPath("paymentMeans[0].creditTransfer", { creditNote: true }),
    "/CreditNote/PaymentMeans[1]/PayeeFinancialAccount",
  );

  // A field with no element of its own falls back to the instruction, and
  // something that is not a location at all is nothing.
  assert.equal(ublPath("paymentMeans[0].mandateReference"), "/Invoice/PaymentMeans[1]");
  assert.equal(ublPath("paymentMeans[-1].typeCode"), undefined);
});

test("the account rules answer to different things: a block, and a code", () => {
  const codeOnly = validate(invoice({ paymentMeans: [{ typeCode: "58" }] }));
  assert.deepEqual(outcomes(codeOnly, "BR-61"), ["fail"]);
  assert.deepEqual(outcomes(codeOnly, "BR-50"), []);
  assert.deepEqual(outcomes(codeOnly, "INVOICERULES-IBAN-01"), []);

  const unknownCode = validate(invoice({ paymentMeans: [{ typeCode: "97" }] }));
  assert.equal(unknownCode.ok, true);
  assert.deepEqual(outcomes(unknownCode, "BR-61"), []);

  // A code that is only whitespace is no code; the account block beside it is
  // still checked under the rule that asks for an identifier.
  const blank = validate(
    invoice({ paymentMeans: [{ typeCode: "", creditTransfer: { accountId: IBAN } }] }),
  );
  assert.deepEqual(outcomes(blank, "BR-49"), ["fail"]);
  assert.deepEqual(outcomes(blank, "BR-50"), ["pass"]);
  assert.deepEqual(outcomes(blank, "BR-61"), []);
  assert.deepEqual(outcomes(blank, "INVOICERULES-IBAN-01"), ["pass"]);

  // Padding does not stop 30 from meaning a credit transfer.
  const padded = validate(invoice({ paymentMeans: [{ typeCode: " 30 " }] }));
  assert.deepEqual(outcomes(padded, "BR-49"), ["pass"]);
  assert.deepEqual(outcomes(padded, "BR-61"), ["fail"]);
});

test("each instruction is reported at its own position", () => {
  const result = validate(
    invoice({
      paymentMeans: [{ typeCode: "30", creditTransfer: { accountId: IBAN } }, { typeCode: "31" }],
    }),
  );
  assert.deepEqual(outcomes(result, "BR-61"), ["pass", "fail"]);
  const violation = result.violations.find((v) => v.rule === "BR-61")!;
  assert.equal(violation.at, "paymentMeans[1].creditTransfer.accountId");
  assert.equal(violation.path, "/Invoice/PaymentMeans[2]/PayeeFinancialAccount/ID");

  // An empty list of instructions is not a failure, and not a check that ran.
  const none = validate(invoice({ paymentMeans: [] }));
  assert.equal(none.ok, true);
  for (const rule of ["BR-49", "BR-50", "BR-61", "INVOICERULES-IBAN-01"]) {
    assert.deepEqual(outcomes(none, rule), [], rule);
  }
});

test("an IBAN is checked for length as well as for its check digits", () => {
  const checked = (accountId: string) =>
    validate(invoice({ paymentMeans: [{ typeCode: "30", creditTransfer: { accountId } }] }));

  // Letters inside the account part are digits 10..35 in the mod 97-10 sum.
  assert.deepEqual(outcomes(checked("GB82WEST12345698765432"), "INVOICERULES-IBAN-01"), ["pass"]);
  assert.deepEqual(
    outcomes(checked("  pl61 1090 1014 0000 0712 1981 2874  "), "INVOICERULES-IBAN-01"),
    ["pass"],
  );

  // Too short and too long for any IBAN, in IBAN shape either way.
  assert.deepEqual(outcomes(checked("PL6110901014"), "INVOICERULES-IBAN-01"), ["fail"]);
  assert.deepEqual(outcomes(checked(IBAN + "1234567"), "INVOICERULES-IBAN-01"), ["fail"]);

  // Grouped with hyphens is not IBAN shape, so it is left alone rather than
  // reported as an IBAN whose check digits fail.
  assert.deepEqual(
    outcomes(checked("PL61-1090-1014-0000-0712-1981-2874"), "INVOICERULES-IBAN-01"),
    [],
  );
  assert.deepEqual(outcomes(checked("PL61"), "INVOICERULES-IBAN-01"), []);

  const short = checked("PL6110901014");
  assert.match(
    short.violations.find((v) => v.rule === "INVOICERULES-IBAN-01")!.message,
    /"PL6110901014" is in IBAN shape/,
  );
});

test("the day it was issued is a due date, and an unreadable issue date orders nothing", () => {
  assert.deepEqual(outcomes(validate(invoice({ dueDate: "2026-08-16" })), "INVOICERULES-DUE-01"), [
    "pass",
  ]);

  const outOfRange = validate(invoice({ dueDate: "2026-13-01" }));
  assert.match(
    outOfRange.violations.find((v) => v.rule === "INVOICERULES-DUE-01")!.message,
    /is not a date/,
  );

  // With no issue date to compare against, the ordering is not claimed either way.
  const noIssueDate = validate(invoice({ issueDate: "16.08.2026" }));
  assert.deepEqual(outcomes(noIssueDate, "INVOICERULES-DUE-01"), []);
  assert.ok(noIssueDate.violations.some((v) => v.rule === "BR-02"));
});

test("a credit note with an unreadable due date is told both things about it", () => {
  const result = validate(invoice({ typeCode: "381", dueDate: "15/09/2026", paymentMeans: [] }));
  assert.deepEqual(outcomes(result, "INVOICERULES-DUE-01"), ["fail", "warning"]);
  for (const entry of entries(result, "INVOICERULES-DUE-01")) {
    assert.equal(entry.path, "/CreditNote/PaymentMeans[1]/PaymentDueDate");
  }
  assert.equal(result.ok, false);

  // Nothing is said about a date that was never given.
  const without = validate(invoice({ typeCode: "381", dueDate: undefined, paymentMeans: [] }));
  assert.equal(without.ok, true);
  assert.deepEqual(outcomes(without, "INVOICERULES-DUE-01"), []);
});

test("a credit note with nowhere to write its due date writes the rest of itself", () => {
  const document = invoice({ typeCode: "381", paymentMeans: undefined });
  assert.equal(validate(document).ok, true);

  const xml = toUBL(document);
  assert.ok(!xml.includes("<cbc:DueDate>"));
  assert.ok(!xml.includes("<cbc:PaymentDueDate>"));
  assert.ok(xml.includes("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>"));
  assert.ok(xml.includes("<cbc:Note>30 days net</cbc:Note>"));
});

test("an instruction nobody can pay into stops the document being written", () => {
  assert.throws(
    () => toUBL(invoice({ paymentMeans: [{ typeCode: "30" }] })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidInvoice);
      assert.ok(error.violations.some((v) => v.rule === "BR-61"));
      return true;
    },
  );

  const anyway = toUBL(invoice({ paymentMeans: [{ typeCode: "30" }] }), { allowInvalid: true });
  assert.ok(anyway.includes("<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>"));
  assert.ok(!anyway.includes("<cac:PayeeFinancialAccount>"));
});

test("a payee or a bank with an ampersand in its name still parses", () => {
  const xml = toUBL(
    invoice({
      payee: { name: 'Factor & Sons "SA"' },
      paymentMeans: [
        {
          typeCode: "30",
          name: 'Credit "fast" transfer',
          remittanceInformation: "A<B",
          creditTransfer: { accountId: IBAN, accountName: "Bank & Co" },
        },
      ],
    }),
  );

  assert.ok(xml.includes("<cbc:Name>Factor &amp; Sons &quot;SA&quot;</cbc:Name>"));
  assert.ok(xml.includes('name="Credit &quot;fast&quot; transfer"'));
  assert.ok(xml.includes("<cbc:PaymentID>A&lt;B</cbc:PaymentID>"));
  assert.ok(xml.includes("<cbc:Name>Bank &amp; Co</cbc:Name>"));
  assert.ok(!xml.includes('name="Credit "fast" transfer"'));
});

test("the due date sits between the code and the rest of the instruction", () => {
  const xml = toUBL(
    invoice({
      typeCode: "381",
      paymentMeans: [
        {
          typeCode: "30",
          remittanceInformation: "KOR-2026-0001",
          creditTransfer: { accountId: IBAN, accountName: "Seller Sp. z o.o.", bic: "WBKPPLPP" },
        },
      ],
    }),
  );

  const order = [
    "<cbc:PaymentMeansCode",
    "<cbc:PaymentDueDate>",
    "<cbc:PaymentID>",
    "<cac:PayeeFinancialAccount>",
    "<cac:FinancialInstitutionBranch>",
  ].map((element) => xml.indexOf(element));
  assert.ok(order.every((index) => index > 0), "an element is missing");
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test("a payee with an empty name fails where a missing payee says nothing", () => {
  const empty = validate(invoice({ payee: { name: "" } }));
  assert.deepEqual(outcomes(empty, "BR-17"), ["fail"]);
  assert.equal(empty.ok, false);

  const named = validate(invoice({ payee: { name: "Factor SA", legalId: "0000123456" } }));
  assert.deepEqual(outcomes(named, "BR-17"), ["pass"]);
  assert.equal(named.ok, true);
});
