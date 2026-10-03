/**
 * Recording the fixtures, and reading them back.
 *
 * The files beside this one are the output of this script. A change in what
 * the library writes, or in how a rule comes out, then shows up as a diff in
 * test/fixtures — either a bug or a fixture update someone decided to make,
 * never a change that passes unnoticed.
 *
 *   npm run fixtures
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../../src/rules.ts";
import type { Result } from "../../src/rules.ts";
import { toUBL } from "../../src/ubl.ts";
import { SCENARIOS } from "./scenarios.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function recordedFile(name: string, extension: string): string {
  return join(here, `${name}.${extension}`);
}

export function readRecorded(name: string, extension: string): string | undefined {
  try {
    return readFileSync(recordedFile(name, extension), "utf8");
  } catch {
    return undefined;
  }
}

/** One line per outcome, and the message only where there is one to give. */
export function renderOutcomes(result: Result): string {
  const lines = [`valid: ${result.ok}`, `checks: ${result.coverage.length}`];
  for (const entry of result.coverage) {
    lines.push(`${entry.outcome} ${entry.rule} ${entry.at ?? "-"}`);
    if (entry.message) lines.push(`    ${entry.message}`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv.includes("--write")) {
  for (const scenario of SCENARIOS) {
    const recordings: [string, string][] = [
      ["xml", toUBL(scenario.invoice)],
      ["outcomes.txt", renderOutcomes(validate(scenario.invoice))],
    ];
    for (const [extension, content] of recordings) {
      const changed = readRecorded(scenario.name, extension) !== content;
      writeFileSync(recordedFile(scenario.name, extension), content);
      console.log(`${changed ? "updated  " : "unchanged"} ${scenario.name}.${extension}`);
    }
  }
}
