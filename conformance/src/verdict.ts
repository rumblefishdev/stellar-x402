/**
 * The suite's `--output-json` file, trimmed to what the gate reads (upstream `e2e/test.ts`, the
 * `results` it writes).
 */
export interface SuiteRun {
  results: SuiteResult[];
}

export interface SuiteResult {
  testNumber: number;
  client: string;
  server: string;
  endpoint: string;
  passed: boolean;
  error?: string;
  transaction?: string;
  /** `authorization` verifies before it serves; `upfront` settles without a `/verify`. */
  paymentFlow?: string;
}

/**
 * What stops the gate passing, one line each; empty means it passed. The suite exits 0 when no
 * scenario matched its filters, writing no file, and its clients report success without a
 * transaction when the payment response header is missing. Neither is evidence, so both fail here,
 * as does any exit but 0, even after a file with every scenario passed, and one hash reported by
 * two scenarios: a facilitator replaying an earlier answer.
 */
export function judge(run: SuiteRun | undefined, exitCode: number | null): string[] {
  const problems: string[] = [];
  if (exitCode !== 0) problems.push(`the suite exited with ${exitCode}`);
  if (!run) {
    problems.push("the suite wrote no results: no scenario matched, or it stopped before running");
    return problems;
  }
  if (run.results.length === 0) problems.push("the suite ran no scenarios");
  const reportedBy = new Map<string, number>();
  for (const result of run.results) {
    const name = `#${result.testNumber} ${result.client} -> ${result.server} ${result.endpoint}`;
    const first = result.transaction ? reportedBy.get(result.transaction) : undefined;
    if (!result.passed) problems.push(`${name} failed: ${result.error ?? "no error given"}`);
    else if (!result.transaction) problems.push(`${name} passed without a transaction hash`);
    else if (first)
      problems.push(`${name} reports transaction ${result.transaction}, as #${first} does`);
    else reportedBy.set(result.transaction, result.testNumber);
  }
  return problems;
}

/**
 * Whether the whole suite ran, and against the facilitator: a run of one good scenario proves
 * little, and the suite's file doesn't say that a call left the machine. `calls` are the lines the
 * proxy wrote, one per forwarded call.
 */
export function judgeCoverage(run: SuiteRun, calls: string[], expectedScenarios: number): string[] {
  const problems: string[] = [];
  const scenarios = run.results.length;
  if (scenarios !== expectedScenarios) {
    problems.push(
      `the suite ran ${scenarios} scenarios, the pinned commit holds ${expectedScenarios}`,
    );
  }
  const verified = calls.filter((call) => call.startsWith("POST /verify -> 200")).length;
  const verifying = run.results.filter((result) => result.paymentFlow === "authorization").length;
  if (verified !== verifying) {
    problems.push(
      `the facilitator answered 200 to ${verified} /verify calls, ${verifying} scenarios verify`,
    );
  }
  const settled = calls.filter((call) => call.startsWith("POST /settle -> 200")).length;
  if (settled < scenarios) {
    problems.push(
      `the facilitator answered 200 to ${settled} /settle calls, ${scenarios} scenarios settled`,
    );
  }
  return problems;
}
