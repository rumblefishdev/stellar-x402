import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/** One checked expectation: the scenario, what was expected, what came back, the hash if paid. */
export interface Row {
  id: string;
  check: string;
  expected: unknown;
  got: unknown;
  pass: boolean;
  transaction?: string;
}

const rows: Row[] = [];

/**
 * Records a row and checks it softly: a failed row fails the run at the end, but the scenarios
 * after it still run, so the table is complete.
 */
export function row(
  id: string,
  check: string,
  expected: unknown,
  got: unknown,
  transaction?: string,
) {
  const pass = JSON.stringify(expected) === JSON.stringify(got);
  rows.push({ id, check, expected, got, pass, transaction });
  expect.soft(got, `${id} ${check}`).toEqual(expected);
}

const RESULTS = fileURLToPath(new URL("../results/testnet-results.json", import.meta.url));

export function writeResults(): void {
  mkdirSync(dirname(RESULTS), { recursive: true });
  const failed = rows.filter((r) => !r.pass).length;
  writeFileSync(
    RESULTS,
    `${JSON.stringify({ ranAt: new Date().toISOString(), rows: rows.length, failed, results: rows }, null, 2)}\n`,
  );
}
