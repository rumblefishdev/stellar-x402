/**
 * The suite's `--output-json` file, trimmed to what the gate reads (upstream `e2e/test.ts`, the
 * `results` and `summary` it writes).
 */
export interface SuiteRun {
  summary: { total: number; passed: number; failed: number };
  results: SuiteResult[];
}

export interface SuiteResult {
  testNumber: number;
  client: string;
  server: string;
  endpoint: string;
  transport?: string;
  passed: boolean;
  error?: string;
  transaction?: string;
}

/**
 * What stops the gate passing, one line each; empty means it passed. The suite exits 0 when no
 * scenario matched its filters, writing no file, and its fetch client reports success without a
 * transaction when the payment response header is missing. Neither is evidence, so both fail here.
 */
export function judge(run: SuiteRun | undefined): string[] {
  if (!run)
    return ["the suite wrote no results: no scenario matched, or it stopped before running"];
  if (run.results.length === 0) return ["the suite ran no scenarios"];

  const problems: string[] = [];
  for (const result of run.results) {
    const name = `#${result.testNumber} ${result.client} -> ${result.server} ${result.endpoint}`;
    if (!result.passed) problems.push(`${name} failed: ${result.error ?? "no error given"}`);
    else if (!result.transaction) problems.push(`${name} passed without a transaction hash`);
  }
  return problems;
}
