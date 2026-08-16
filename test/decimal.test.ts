import { test } from "node:test";
import assert from "node:assert/strict";

import { Decimal, InvalidNumber, sum } from "../src/decimal.ts";

const d = (value: string) => Decimal.parse(value);

// The reason this module exists rather than using numbers.
test("addition is exact where floating point is not", () => {
  assert.equal(d("0.1").add(d("0.2")).toFixed(2), "0.30");
  assert.notEqual(0.1 + 0.2, 0.3);

  assert.equal(sum(["19.99", "0.01", "80.00"]).toFixed(2), "100.00");
});

test("percentages land on the cent", () => {
  assert.equal(d("200.00").percentOf(d("23")).toFixed(2), "46.00");
  assert.equal(d("99.99").percentOf(d("23")).toFixed(2), "23.00");
  assert.equal(d("33.33").percentOf(d("7.5")).toFixed(2), "2.50");
});

test("rounding is half-up, in both directions", () => {
  assert.equal(d("2.345").round(2).toString(), "2.35");
  assert.equal(d("2.344").round(2).toString(), "2.34");
  assert.equal(d("-2.345").round(2).toString(), "-2.35");
  assert.equal(d("2.5").round(0).toString(), "3");
});

test("scales are aligned rather than truncated", () => {
  assert.equal(d("1.5").add(d("2.25")).toString(), "3.75");
  assert.equal(d("10").subtract(d("0.001")).toString(), "9.999");
});

test("comparison and tolerance", () => {
  assert.equal(d("1.00").compare(d("1.000")), 0);
  assert.equal(d("1.01").compare(d("1.00")), 1);
  assert.ok(d("46.01").equalsWithin(d("46.00"), d("0.01")));
  assert.ok(d("45.99").equalsWithin(d("46.00"), d("0.01")));
  assert.ok(!d("46.02").equalsWithin(d("46.00"), d("0.01")));
});

test("formatting keeps the scale an invoice needs", () => {
  assert.equal(d("5").toFixed(2), "5.00");
  assert.equal(d("5.5").toFixed(2), "5.50");
  assert.equal(d("0").toFixed(2), "0.00");
  assert.equal(d("-0.5").toFixed(2), "-0.50");
});

test("what is not a number is refused rather than coerced", () => {
  for (const value of ["", " ", "abc", "1,50", "1.2.3", "1e5", "--1"]) {
    assert.throws(() => Decimal.parse(value), InvalidNumber, `accepted "${value}"`);
  }
});
