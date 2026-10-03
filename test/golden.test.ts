import { test } from "node:test";
import assert from "node:assert/strict";

import { validate } from "../src/rules.ts";
import { toUBL } from "../src/ubl.ts";
import { readRecorded, renderOutcomes } from "./fixtures/record.ts";
import { SCENARIOS } from "./fixtures/scenarios.ts";

// A change in the document a receiver gets, or in how a rule comes out, has to
// be a change someone made on purpose. The fixtures are rewritten by hand with
// `npm run fixtures`, so the diff is reviewed rather than absorbed.
const UPDATE = "npm run fixtures";

for (const scenario of SCENARIOS) {
  test(`${scenario.name}: writes the document that was recorded`, () => {
    const recorded = readRecorded(scenario.name, "xml");
    assert.ok(recorded, `nothing recorded for ${scenario.name} (${scenario.about}); run ${UPDATE}`);
    assert.equal(
      toUBL(scenario.invoice),
      recorded,
      `the UBL written for ${scenario.name} changed; if that is intended, run ${UPDATE}`,
    );
  });

  test(`${scenario.name}: the rules come out as recorded`, () => {
    const recorded = readRecorded(scenario.name, "outcomes.txt");
    assert.ok(recorded, `no recorded outcomes for ${scenario.name}; run ${UPDATE}`);
    assert.equal(
      renderOutcomes(validate(scenario.invoice)),
      recorded,
      `the rule outcomes for ${scenario.name} changed; if that is intended, run ${UPDATE}`,
    );
  });
}
