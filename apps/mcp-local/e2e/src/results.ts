import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
 * after it still run, so the table is complete. The file and vitest use the same comparison.
 */
export function row(
  id: string,
  check: string,
  expected: unknown,
  got: unknown,
  transaction?: string,
) {
  const pass = isDeepStrictEqual(got, expected);
  rows.push({ id, check, expected, got, pass, transaction });
  expect.soft(pass, `${id} ${check}: expected ${show(expected)}, got ${show(got)}`).toBe(true);
}

function show(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (v === undefined ? "<undefined>" : v));
}

const RESULTS = fileURLToPath(new URL("../results/testnet-results.json", import.meta.url));

/**
 * Writes the table, with the commit it ran on. A run whose setup failed writes the error instead,
 * so the file never shows a clean result for a run that checked nothing.
 */
export function writeResults(setupError?: unknown): void {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const failed = rows.filter((r) => !r.pass).length;
  const report =
    setupError !== undefined || rows.length === 0
      ? {
          ranAt: new Date().toISOString(),
          commit,
          setupError: String(setupError ?? "no checks ran"),
        }
      : { ranAt: new Date().toISOString(), commit, rows: rows.length, failed, results: rows };
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(
    RESULTS,
    `${JSON.stringify(report, (_, v: unknown) => (v === undefined ? "<undefined>" : v), 2)}\n`,
  );
}
