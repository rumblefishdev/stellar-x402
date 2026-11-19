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
}

/** What the gate knows of a run beside the suite's file: which code was tested, and by which. */
export interface RunRecord {
  /** The commit the facilitator names on `/health`; null when it names none. */
  facilitatorCommit: string | null;
  /** `git status --porcelain` of the gate's own code; empty when it is all committed. */
  gateChanges: string;
}

/**
 * What stops the gate passing, one line each; empty means it passed. The suite exits 0 when no
 * scenario matched its filters, writing no file, and its clients report success without a
 * transaction when the payment response header is missing. Neither is evidence, so both fail here,
 * as does any exit but 0, even after a file with every scenario passed, and one hash reported by
 * two scenarios: a facilitator replaying an earlier answer. A run of record also says which
 * facilitator build answered and which gate judged it, so a facilitator that names no commit and
 * gate code that isn't the commit it names fail too, whatever the suite did.
 */
export function judge(
  run: SuiteRun | undefined,
  exitCode: number | null,
  record: RunRecord,
): string[] {
  const problems: string[] = [];
  if (exitCode !== 0) problems.push(`the suite exited with ${exitCode}`);
  if (!run)
    problems.push("the suite wrote no results: no scenario matched, or it stopped before running");
  else if (run.results.length === 0) problems.push("the suite ran no scenarios");
  const reportedBy = new Map<string, number>();
  for (const result of run?.results ?? []) {
    const name = `#${result.testNumber} ${result.client} -> ${result.server} ${result.endpoint}`;
    const first = result.transaction ? reportedBy.get(result.transaction) : undefined;
    if (!result.passed) problems.push(`${name} failed: ${result.error ?? "no error given"}`);
    else if (!result.transaction) problems.push(`${name} passed without a transaction hash`);
    else if (first)
      problems.push(`${name} reports transaction ${result.transaction}, as #${first} does`);
    else reportedBy.set(result.transaction, result.testNumber);
  }
  if (!record.facilitatorCommit) problems.push("the facilitator names no commit on /health");
  if (record.gateChanges) problems.push(`the gate has uncommitted changes:\n${record.gateChanges}`);
  return problems;
}

/**
 * Our deployed facilitators, by host: only a run against one of them is a run of record. A new
 * deployment joins the list in its own pull request before its first run of record.
 */
export const HOSTED_FACILITATORS: readonly string[] = ["x402-facilitator.sorobanscan.com"];

/**
 * The results folder for a facilitator at `url`. `testnet-hosted/` is committed and each run
 * there replaces the run of record, so it is named, not guessed: any other host, a dry run
 * against x402.org, this machine or a mistyped URL, goes to `testnet-local/`, which git ignores.
 */
export function resultsFolder(url: string): "testnet-local" | "testnet-hosted" {
  return HOSTED_FACILITATORS.includes(new URL(url).hostname) ? "testnet-hosted" : "testnet-local";
}
