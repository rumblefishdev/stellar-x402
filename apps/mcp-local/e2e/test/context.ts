import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequired } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { type FakeCatalog, startFakeCatalog } from "../../../../packages/mcp/test/fake-catalog.js";
import { running, startServer } from "../src/cli.js";
import type { FakeSeller } from "../src/fakes.js";
import { friendbot, usdcBalance } from "../src/horizon.js";
import { type Keys, readKeys } from "../src/keys.js";
import { writeResults } from "../src/results.js";
import { type ExampleSeller, startExampleSeller } from "../src/seller.js";

/** The example seller's price: 0.001 testnet USDC. */
export const PRICE = "10000";
/** Enough testnet USDC for two payments and a rerun; below it the run stops before any check. */
const MIN_BUYER_USDC = 100_000n;

export let keys: Keys;
export let unfunded: Keypair;
export let catalog: FakeCatalog;
export let example: ExampleSeller;
/** The example seller's 402; the fake sellers answer copies of it, so a real key signs them. */
export let terms: PaymentRequired;
let setupError: unknown;
const scratch = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
let dirs = 0;

/** One catalog entry of the scenarios' catalog. */
function entry(
  resource: string,
  type: "http" | "mcp",
  network: string,
  payTo: string,
  bazaar: boolean,
): DiscoveryResource {
  return {
    resource,
    type,
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network,
        amount: PRICE,
        asset: "CUSDC",
        payTo,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    lastUpdated: "2026-10-14T00:00:00.000Z",
    description: `${resource} entry`,
    ...(bazaar && { extensions: { bazaar: { info: { input: { type, method: "GET" } } } } }),
  } as DiscoveryResource;
}
// Two payees and both networks, so each filter changes the answer.
export const H1 = entry("https://h1.example.com/", "http", "stellar:testnet", "GPAYEE1", true);
export const H2 = {
  ...entry("https://h2.example.com/", "http", "stellar:testnet", "GPAYEE2", false),
  description: "d".repeat(10_000),
};
export const H3 = entry("https://h3.example.com/", "http", "stellar:pubnet", "GPAYEE1", false);
export const M1 = entry("https://m1.example.com/mcp", "mcp", "stellar:testnet", "GPAYEE1", true);
export const M2 = entry("https://m2.example.com/mcp", "mcp", "stellar:testnet", "GPAYEE2", false);
export const CATALOG = [H1, H2, H3, M1, M2];

/** A fresh, empty state directory, so each scenario's daily budget starts at zero. */
export function freshDir(): string {
  return join(scratch, `state-${++dirs}`);
}

/** Settings without a key; a 3 s time limit keeps the scenarios that wait short. */
export function base(extra: Record<string, string> = {}): Record<string, string> {
  return {
    STELLAR_X402_DISCOVERY_URL: catalog.url,
    STELLAR_X402_ALLOW_INSECURE_LOCAL: "1",
    STELLAR_X402_TIMEOUT_MS: "3000",
    ...extra,
  };
}

export function paying(extra: Record<string, string> = {}): Record<string, string> {
  return base({
    STELLAR_X402_SECRET_KEY: keys.buyerSecret,
    STELLAR_X402_MAX_PER_CALL: PRICE,
    STELLAR_X402_DAILY_BUDGET: "1000000",
    STELLAR_X402_STATE_DIR: freshDir(),
    ...extra,
  });
}

export const weather = () => `${example.url}/weather?city=Warsaw`;
/** A seller tool's arguments for a GET of `url`. */
export const httpArgs = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  method: "GET",
  ...extra,
});
export const paidAt = (fake: FakeSeller, path?: string) =>
  fake.requests.filter((r) => r.paid && (path === undefined || r.path === path)).length;
export const hitsOf = (fake: FakeSeller, path: string) =>
  fake.requests.filter((r) => r.path === path).length;

/** What a state directory's database has counted, in atomic units. */
export function counted(dir: string): string {
  const db = new DatabaseSync(join(dir, "spent.sqlite"));
  try {
    const { total } = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM spent").get() as {
      total: number;
    };
    return String(total);
  } finally {
    db.close();
  }
}

/** Waits for Horizon to show a balance other than `before`, up to 30 s; the last read otherwise. */
export async function balanceAfter(account: string, before: bigint): Promise<bigint> {
  let now = before;
  for (let i = 0; i < 30 && now === before; i++) {
    await new Promise((done) => setTimeout(done, 1_000));
    now = await usdcBalance(account);
  }
  return now;
}

/** Starts what every scenario needs; a failure stops the run before any check. */
export async function setUp(): Promise<void> {
  try {
    keys = readKeys();
    const balance = await usdcBalance(keys.buyerPublic);
    if (balance < MIN_BUYER_USDC)
      throw new Error(
        `the buyer holds ${balance} atomic USDC, under ${MIN_BUYER_USDC}: top it up from Circle's testnet faucet`,
      );
    unfunded = Keypair.random();
    await friendbot(unfunded.publicKey());
    catalog = await startFakeCatalog(CATALOG);
    example = await startExampleSeller(keys.sellerPublic);
    // The fake sellers copy these terms; without them no later scenario means anything.
    const server = await startServer(base());
    const answer = await server.call("get_resource", httpArgs(weather()));
    await server.close();
    terms = (answer.value as { paymentRequired: PaymentRequired }).paymentRequired;
    if (!terms?.accepts?.[0])
      throw new Error(`the example seller's terms cannot be read: ${answer.text}`);
  } catch (error) {
    setupError = error;
    throw error;
  }
}

/** Closes what the scenarios left open and writes the results table. */
export async function tearDown(): Promise<void> {
  // A scenario that threw left its servers open.
  await Promise.all([...running].map((server) => server.close()));
  example?.stop();
  await catalog?.close();
  rmSync(scratch, { recursive: true, force: true });
  writeResults(setupError);
}
