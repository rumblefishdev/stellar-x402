// The Tranche 1 gate (ADR 0009): the unmodified x402 e2e suite, pinned, runs every Stellar `exact`
// scenario against the facilitator at GATE_FACILITATOR_URL through the proxy in
// `conformance/external-proxy/`, and the run is saved with the pin and the transaction hashes.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { checkSettlement, readSettlement, type Settlement } from "./onchain.js";
import { UPSTREAM_COMMIT, UPSTREAM_REPO, assertClean, prepare } from "./upstream.js";
import { judge, type SuiteRun } from "./verdict.js";

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

// A new folder per run, gone when the gate exits, failed or not (~6 GB). Its real path, as stack
// traces print it (macOS links /var to /private/var).
const checkout = realpathSync(mkdtempSync(join(tmpdir(), "x402-gate-")));
process.on("exit", () => rmSync(checkout, { recursive: true, force: true }));
process.once("SIGINT", () => process.exit(130));
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
const filters = [
  "test",
  "--testnet",
  "--families=stellar",
  "--schemes=exact",
  "--facilitators=stellar-x402",
];
const args = [...filters, `--output-json=${suiteJson}`];
console.log(`$ pnpm ${args.join(" ")}   (in ${e2e})`);
const startedAt = Math.floor(Date.now() / 1000);
const suite = spawnSync("pnpm", args, {
  cwd: e2e,
  stdio: "inherit",
  env: {
    ...process.env,
    GATE_FACILITATOR_URL: facilitatorUrl,
    CLIENT_STELLAR_PRIVATE_KEY: accounts.E2E_BUYER_SECRET,
    SERVER_STELLAR_ADDRESS: accounts.E2E_SELLER_PUBLIC,
    // The suite will not start without it, even for an external facilitator; the proxy ignores it.
    FACILITATOR_STELLAR_PRIVATE_KEY: "unused-by-the-gate-proxy",
  },
});
if (suite.error) throw suite.error;

const run = existsSync(suiteJson)
  ? (JSON.parse(readFileSync(suiteJson, "utf8")) as SuiteRun)
  : undefined;
const problems = judge(run, suite.status);

// The suite reports a hash; the chain says what it paid. Every Stellar route costs $0.001, 10000
// units of testnet USDC (7 decimals), at the pinned commit (e2e/config/mechanisms_stellar.json,
// typescript/packages/mechanisms/stellar/src/constants.ts).
const expected = {
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  from: Keypair.fromSecret(accounts.E2E_BUYER_SECRET!).publicKey(),
  to: accounts.E2E_SELLER_PUBLIC!,
  amount: 10000n,
  signers: stellarSigners,
  notBefore: startedAt,
};
const chain = new rpc.Server("https://soroban-testnet.stellar.org");
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

if (run) {
  const date = new Date().toISOString();
  const file = join(
    conformance,
    "results",
    `${date.replace(/[:.]/g, "-")}-${new URL(facilitatorUrl).host}.json`,
  );
  mkdirSync(join(conformance, "results"), { recursive: true });
  const record = {
    upstream: { repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT },
    date,
    facilitatorUrl,
    command: `pnpm ${filters.join(" ")}`,
    signers: stellarSigners,
    startedAt: new Date(startedAt * 1000).toISOString(),
    suiteExitCode: suite.status,
    passed: problems.length === 0,
    problems,
    settlements,
    ...run,
  };
  // Errors carry stack traces through the local checkout; results are committed (task 0029), so
  // the machine's own path stays out.
  const text = JSON.stringify(record, null, 2).replaceAll(checkout, "<x402 checkout>");
  writeFileSync(file, `${text}\n`);
  console.log(`Saved ${file}`);
}

if (problems.length > 0) {
  console.error(`Gate failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Gate passed: ${settlements.length} scenarios, each settled on chain in this run, buyer to seller for the price, by a facilitator signer`,
);
