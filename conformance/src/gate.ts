// The Tranche 1 gate (ADR 0009): the unmodified x402 e2e suite, pinned, runs every Stellar `exact`
// scenario against the facilitator at GATE_FACILITATOR_URL through the proxy in
// `conformance/external-proxy/`, and the run is saved with the pin and the transaction hashes.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { checkSettlement, readSettlement, type Settlement } from "./onchain.js";
import {
  UPSTREAM_COMMIT,
  UPSTREAM_REPO,
  UPSTREAM_SCENARIOS,
  assertClean,
  prepare,
} from "./upstream.js";
import { judge, judgeCoverage, type SuiteRun } from "./verdict.js";

const conformance = fileURLToPath(new URL("..", import.meta.url));
const root = join(conformance, "..");

const facilitatorUrl = process.env.GATE_FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error(
    "Set GATE_FACILITATOR_URL to the facilitator under test, e.g. https://x402.org/facilitator",
  );
  process.exit(1);
}

// The testnet accounts of the MCP e2e run: a buyer holding testnet USDC, a seller with a USDC
// trustline (apps/mcp-local/e2e/README.md).
const envFile = process.env.E2E_ENV_FILE ?? join(root, ".env.e2e-testnet");
const accounts = parseEnv(readFileSync(envFile, "utf8"));
for (const name of ["E2E_BUYER_SECRET", "E2E_SELLER_PUBLIC"]) {
  if (!accounts[name]) throw new Error(`${name} is missing from ${envFile}`);
}

// The accounts that may pay a settlement's fee: the facilitator's own signers. Asked before any
// payment, so an unreachable facilitator stops the run with nothing spent.
const supported = await fetch(`${facilitatorUrl}/supported`);
if (!supported.ok) throw new Error(`GET ${facilitatorUrl}/supported answered ${supported.status}`);
const { signers = {} } = (await supported.json()) as { signers?: Record<string, string[]> };
const stellarSigners = Object.entries(signers)
  .filter(([family]) => family.startsWith("stellar:"))
  .flatMap(([, addresses]) => addresses);
if (stellarSigners.length === 0) {
  throw new Error(
    `${facilitatorUrl}/supported lists no Stellar signers: ${JSON.stringify(signers)}`,
  );
}

// Which build answers, for the record: our facilitator names its commit on /health (a public one
// used for a dry run may not).
const health = await fetch(`${facilitatorUrl}/health`);
const { commit: facilitatorCommit = null } = health.ok
  ? ((await health.json()) as { commit?: string })
  : {};
console.log(`Facilitator commit: ${facilitatorCommit}`);

// A new folder per run, gone when the gate exits, failed or not (~6 GB). In /tmp, not $TMPDIR:
// the suite's stack traces print this path into suite.json, which is committed as is, and
// $TMPDIR on macOS names a per-user folder. Its real path, as stack traces print it (macOS links
// /tmp to /private/tmp).
const checkout = realpathSync(mkdtempSync("/tmp/x402-gate-"));
let suite: ChildProcess | undefined;
process.on("exit", () => {
  // A suite left running would go on paying from a folder that is gone. The whole group: pnpm
  // doesn't stop its children when it is stopped (measured, servers still up 15 s after).
  if (suite?.pid) process.kill(-suite.pid);
  rmSync(checkout, { recursive: true, force: true });
});
// Node exits on these signals without emitting "exit"; exiting here runs the cleanup above. The
// handlers stay for every signal: a second one (Ctrl+C again, or pnpm passing it on) during the
// cleanup would otherwise kill the gate halfway through it.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));
prepare(checkout);

// The proxy goes in under its config's name, which is what --facilitators matches.
const e2e = join(checkout, "e2e");
cpSync(
  join(conformance, "external-proxy"),
  join(e2e, "facilitators", "external-proxies", "stellar-x402"),
  { recursive: true },
);
assertClean(checkout);

const suiteJson = join(checkout, "gate-results.json");
const callsFile = join(checkout, "gate-calls.log");
const filters = [
  "test",
  "--testnet",
  "--families=stellar",
  "--schemes=exact",
  "--facilitators=stellar-x402",
];
const args = [...filters, `--output-json=${suiteJson}`];
// A settlement of this run lands in a ledger after this one.
const chain = new rpc.Server("https://soroban-testnet.stellar.org");
const ledgerBeforeRun = (await chain.getLatestLedger()).sequence;
console.log(`$ pnpm ${args.join(" ")}   (in ${e2e})`);
const startedAt = Math.floor(Date.now() / 1000);
// Not spawnSync: a process blocked for a whole run can't see RPC close its idle connection, and the
// first read after the run fails on that dead connection.
suite = spawn("pnpm", args, {
  cwd: e2e,
  stdio: "inherit",
  detached: true,
  env: {
    ...process.env,
    GATE_FACILITATOR_URL: facilitatorUrl,
    GATE_CALLS_FILE: callsFile,
    CLIENT_STELLAR_PRIVATE_KEY: accounts.E2E_BUYER_SECRET,
    SERVER_STELLAR_ADDRESS: accounts.E2E_SELLER_PUBLIC,
    // The suite will not start without it, even for an external facilitator; the proxy ignores it.
    FACILITATOR_STELLAR_PRIVATE_KEY: "unused-by-the-gate-proxy",
  },
});
const [suiteExitCode] = (await once(suite, "close")) as [number | null];
suite = undefined;

const run = existsSync(suiteJson)
  ? (JSON.parse(readFileSync(suiteJson, "utf8")) as SuiteRun)
  : undefined;
const problems = judge(run, suiteExitCode);
const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "";
if (run) problems.push(...judgeCoverage(run, calls.split("\n"), UPSTREAM_SCENARIOS));
if (!facilitatorCommit) problems.push("the facilitator names no commit on /health");
// A run of record says which gate judged it, so that code must be the commit it names.
const gateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: conformance,
  encoding: "utf8",
}).trim();
const gateChanges = execFileSync("git", ["status", "--porcelain", "--", "src", "external-proxy"], {
  cwd: conformance,
  encoding: "utf8",
}).trim();
if (gateChanges) problems.push(`the gate has uncommitted changes:\n${gateChanges}`);

// The suite reports a hash; the chain says what it paid. Every Stellar route costs $0.001, 10000
// units of testnet USDC (7 decimals), at the pinned commit (e2e/config/mechanisms_stellar.json,
// typescript/packages/mechanisms/stellar/src/constants.ts).
const expected = {
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  from: Keypair.fromSecret(accounts.E2E_BUYER_SECRET!).publicKey(),
  to: accounts.E2E_SELLER_PUBLIC!,
  amount: 10000n,
  signers: stellarSigners,
  ledgerBeforeRun,
};
const settlements: Settlement[] = [];
for (const result of run?.results ?? []) {
  if (!result.passed || !result.transaction) continue;
  const hash = result.transaction;
  // A failed read is a problem of this run, not a crash: the run is saved unless interrupted.
  try {
    const answer = await chain.getTransaction(hash);
    const settlement =
      answer.status === "NOT_FOUND"
        ? { transaction: hash, status: answer.status }
        : readSettlement(
            hash,
            answer.status,
            answer.ledger,
            answer.createdAt,
            answer.envelopeXdr.toXDR("base64"),
          );
    settlements.push(settlement);
    const problem = checkSettlement(settlement, expected);
    if (problem) problems.push(`#${result.testNumber} transaction ${hash} ${problem}`);
  } catch (error) {
    problems.push(`#${result.testNumber} transaction ${hash} could not be read on chain: ${error}`);
  }
}
console.log(`Read ${settlements.length} transactions on chain`);

// One folder per run: the suite's own file, copied byte for byte, and the gate's verdict on it,
// which names that file and its hash so the two are read as one run.
if (run) {
  const date = new Date().toISOString();
  const folder = join(
    conformance,
    "results",
    `${date.replace(/[:.]/g, "-")}-${new URL(facilitatorUrl).host}`,
  );
  mkdirSync(folder, { recursive: true });
  copyFileSync(suiteJson, join(folder, "suite.json"));
  writeFileSync(join(folder, "calls.log"), calls);
  const record = {
    suiteFile: "suite.json",
    suiteSha256: createHash("sha256").update(readFileSync(suiteJson)).digest("hex"),
    upstream: { repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT },
    gateCommit,
    date,
    facilitatorUrl,
    facilitatorCommit,
    command: `pnpm ${filters.join(" ")}`,
    signers: stellarSigners,
    startedAt: new Date(startedAt * 1000).toISOString(),
    ledgerBeforeRun,
    suiteExitCode,
    passed: problems.length === 0,
    problems,
    settlements,
  };
  // Problems quote the suite's errors, whose stack traces run through the temporary checkout.
  const text = JSON.stringify(record, null, 2).replaceAll(checkout, "<x402 checkout>");
  writeFileSync(join(folder, "gate.json"), `${text}\n`);
  console.log(`Saved ${folder}/suite.json and gate.json`);
}

if (problems.length > 0) {
  console.error(`Gate failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Gate passed: ${settlements.length} scenarios, each settled on chain in this run, buyer to seller for the price, by a facilitator signer`,
);
