// The Tranche 1 gate (ADR 0009): the unmodified x402 e2e suite, pinned, runs every Stellar `exact`
// scenario against the facilitator at GATE_FACILITATOR_URL through the proxy in
// `conformance/external-proxy/`, and the run is saved with the pin and the transaction hashes.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
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

const checkout = join(conformance, ".cache", `x402-${UPSTREAM_COMMIT.slice(0, 7)}`);
prepare(checkout);

// The proxy goes in under its config's name, which is what --facilitators matches.
const e2e = join(checkout, "e2e");
const proxy = join(e2e, "facilitators", "external-proxies", "stellar-x402");
rmSync(proxy, { recursive: true, force: true });
cpSync(join(conformance, "external-proxy"), proxy, { recursive: true });
assertClean(checkout);

const suiteJson = join(checkout, "gate-results.json");
rmSync(suiteJson, { force: true });
const args = [
  "test",
  "--testnet",
  "--families=stellar",
  "--schemes=exact",
  "--facilitators=stellar-x402",
  `--output-json=${suiteJson}`,
];
console.log(`$ pnpm ${args.join(" ")}   (in ${e2e})`);
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
const problems = judge(run);

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
    command: `pnpm ${args.slice(0, -1).join(" ")}`,
    suiteExitCode: suite.status,
    passed: problems.length === 0,
    problems,
    ...run,
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Saved ${file}`);
}

if (problems.length > 0) {
  console.error(`Gate failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`Gate passed: ${run?.results.length} scenarios, each with a transaction hash`);
