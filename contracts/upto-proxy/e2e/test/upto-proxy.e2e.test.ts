// UptoProxy on testnet (task 0004). Settlements go through SettlementSubmitter in the
// delegated-bump shape: a channel is the transaction source, the facilitator is the operation
// source and pays the fee bump. Rejections are checked in the submitter's enforcing simulation
// against live testnet state, so they have no transaction hash.
//
// Run from the repo root: pnpm contracts:e2e. Results go to results/testnet-results.json.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, type xdr } from "@stellar/stellar-sdk";
import { type ContractCall, SettlementSubmitter, keypairSigner } from "@stellar-x402/signer-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSPHRASE,
  RPC_URL,
  type TxReport,
  contractTtls,
  readContract,
  server,
  tokenBalance,
  txReport,
  xlmBalance,
} from "../src/chain.js";
import {
  type UptoTerms,
  checkClientAuth,
  clientSign,
  clientSignDirect,
  newTerms,
  nonceArgs,
  settleCall,
} from "../src/upto.js";
import { type TokenKind, type World, prepareWorld } from "../src/world.js";

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "../results/testnet-results.json");
const MAX = 1_000_000n; // 0.1 of a 7-decimal token
// The contract's own TTL targets (lib.rs, task 0035), in ledgers.
const TTL_EXTEND_TO = 518_400;
const TTL_MIN_EXTENSION = 120;
// E2E_TOKENS=sac,sep41 runs a subset; a full run (the default) covers all three.
const TOKENS = (process.env.E2E_TOKENS?.split(",") ?? ["usdc", "sac", "sep41"]) as TokenKind[];

interface ScenarioResult {
  token: TokenKind | "all";
  scenario: string;
  expected: string;
  outcome: string;
  pass: boolean;
  transactions: TxReport[];
  /** Simulation error for a rejection, first matching line. */
  error?: string;
  /** Allowance the proxy keeps after a settlement (`max_amount - actual_amount`). */
  leftoverAllowance?: string;
}

let world: World;
let submitter: SettlementSubmitter;
let otherSubmitter: SettlementSubmitter;
let expLedger: number;
let clientXlmBefore: bigint;
const results: ScenarioResult[] = [];
/** The last successful settlement per token, replayed by the replay scenarios. */
const settled = new Map<TokenKind, { terms: UptoTerms; auth: xdr.SorobanAuthorizationEntry }>();

beforeAll(async () => {
  world = await prepareWorld({ needUsdc: TOKENS.includes("usdc") });
  const options = { rpc: server, networkPassphrase: PASSPHRASE, timeoutSeconds: 60 };
  submitter = new SettlementSubmitter({
    ...options,
    signer: keypairSigner(world.facilitator),
    channels: world.channels,
  });
  otherSubmitter = new SettlementSubmitter({
    ...options,
    signer: keypairSigner(world.otherFacilitator),
    channels: world.otherChannels,
  });
  expLedger = (await server.getLatestLedger()).sequence + 500;
  // Taken after setup, which pays the client's trustline fees: the check covers settlements.
  clientXlmBefore = await xlmBalance(world.client.publicKey());
});

afterAll(() => {
  if (!world) return;
  const report = {
    runAt: new Date().toISOString(),
    network: "stellar:testnet",
    rpc: RPC_URL,
    proxy: world.proxy,
    testToken: world.testToken,
    tokens: world.tokens,
    /** The tokens this run covered; a subset run (E2E_TOKENS) leaves the others out. */
    tokensRun: TOKENS,
    accounts: {
      facilitator: world.facilitator.publicKey(),
      otherFacilitator: world.otherFacilitator.publicKey(),
      client: world.client.publicKey(),
      seller: world.seller.publicKey(),
      channels: world.channels,
      otherChannels: world.otherChannels,
    },
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    scenarios: results,
  };
  writeFileSync(
    RESULTS,
    `${JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
  );
});

const terms = (kind: TokenKind, overrides: Partial<UptoTerms> = {}) =>
  newTerms(
    {
      proxy: world.proxy.contractId,
      token: world.tokens[kind],
      from: world.client.publicKey(),
      to: world.seller.publicKey(),
      facilitator: world.facilitator.publicKey(),
      maxAmount: MAX,
      allowanceExpirationLedger: expLedger,
    },
    overrides,
  );

/** Runs `body`, recording its outcome whether it passes or throws. */
async function scenario(
  token: TokenKind | "all",
  name: string,
  expected: string,
  body: (r: ScenarioResult) => Promise<void>,
) {
  const r: ScenarioResult = {
    token,
    scenario: name,
    expected,
    outcome: "",
    pass: false,
    transactions: [],
  };
  results.push(r);
  try {
    await body(r);
    r.pass = true;
  } catch (error) {
    r.outcome ||= `failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    throw error;
  }
}

const balances = async (t: UptoTerms) => {
  const src = world.facilitator.publicKey();
  return {
    client: await tokenBalance(t.token, t.from, src),
    seller: await tokenBalance(t.token, t.to, src),
  };
};

const allowanceOf = async (t: UptoTerms) =>
  BigInt(
    (await readContract(
      t.token,
      "allowance",
      [Address.fromString(t.from).toScVal(), Address.fromString(t.proxy).toScVal()],
      t.facilitator,
    )) as bigint,
  );

/**
 * Checks what a successful settlement must leave on chain, except the balances: the
 * delegated-bump shape, the event, the used nonce and, unless another settlement from the same
 * payer may have run after it, the leftover allowance.
 */
async function checkSettled(
  r: ScenarioResult,
  t: UptoTerms,
  hash: string,
  actual: bigint,
  { allowance = true } = {},
): Promise<TxReport> {
  const tx = await txReport(hash, t.proxy);
  r.transactions.push(tx);

  // Delegated-bump shape: the facilitator pays, a channel provides the sequence number.
  expect(tx.feeSource).toBe(t.facilitator);
  expect(tx.opSource).toBe(t.facilitator);
  expect(world.channels).toContain(tx.txSource);
  expect([tx.feeSource, tx.txSource, tx.opSource]).not.toContain(t.from);

  expect(tx.events).toHaveLength(1);
  const [event] = tx.events as { topics: unknown[]; data: Record<string, unknown> }[];
  expect(event!.topics).toEqual(["upto_settled", t.token, t.from, t.to]);
  expect(event!.data.facilitator).toBe(t.facilitator);
  expect(BigInt(event!.data.max_amount as bigint)).toBe(t.maxAmount);
  expect(BigInt(event!.data.actual_amount as bigint)).toBe(actual);

  expect(await readContract(t.proxy, "is_nonce_used", nonceArgs(t), t.facilitator)).toBe(true);
  if (allowance) {
    const left = await allowanceOf(t);
    expect(left).toBe(t.maxAmount - actual);
    r.leftoverAllowance = String(left);
  }
  return tx;
}

/** Submits through the pool and checks everything a successful settlement must leave on chain. */
async function settleAndCheck(
  r: ScenarioResult,
  t: UptoTerms,
  auth: xdr.SorobanAuthorizationEntry,
  actual: bigint,
): Promise<TxReport> {
  checkClientAuth(auth, t);
  const before = await balances(t);
  const result = await submitter.submit(settleCall(auth, t, actual));
  expect(result.status, `submit ${result.hash}: ${result.errorCode ?? ""}`).toBe("success");
  const tx = await checkSettled(r, t, result.hash!, actual);
  const after = await balances(t);
  expect(before.client - after.client).toBe(actual);
  expect(after.seller - before.seller).toBe(actual);
  return tx;
}

/** Expects the submitter's enforcing simulation to refuse `call` with `error`. */
async function expectRefused(
  r: ScenarioResult,
  call: ContractCall,
  error: RegExp,
  via: SettlementSubmitter = submitter,
) {
  const outcome = await via.submit(call).then(
    (result) => ({ sent: result }),
    (thrown: unknown) => ({ thrown }),
  );
  if ("sent" in outcome) {
    throw new Error(`expected a refusal, but it was submitted: ${JSON.stringify(outcome.sent)}`);
  }
  const message = outcome.thrown instanceof Error ? outcome.thrown.message : String(outcome.thrown);
  r.error = message.split("\n").find((line) => error.test(line)) ?? message.split("\n")[0];
  expect(message).toMatch(error);
  r.outcome = "rejected in simulation";
}

const CONTRACT = (code: number) => new RegExp(`Error\\(Contract, #${code}\\)`);
/** The entry's own nonce was already consumed by the first settlement. */
const REPLAYED = /Error\(Auth, ExistingValue\)/;
/** A signed tree that doesn't match the call, or a facilitator that didn't authorize it. */
const AUTH_MISMATCH = /Error\(Auth, InvalidAction\)/;

describe.each(TOKENS)("UptoProxy on testnet with %s", (kind) => {
  for (const [name, fraction] of [
    ["settles below the ceiling", 4n],
    ["settles at the ceiling", 1n],
  ] as const) {
    it(name, () =>
      scenario(kind, name, "success", async (r) => {
        const t = terms(kind);
        const auth = await clientSign(t, world.client, expLedger);
        await settleAndCheck(r, t, auth, MAX / fraction);
        settled.set(kind, { terms: t, auth });
        r.outcome = "success";
      }),
    );
  }

  it("settles zero", () =>
    scenario(kind, "settles zero", "success, no transfer, event and nonce recorded", async (r) => {
      const t = terms(kind);
      await settleAndCheck(r, t, await clientSign(t, world.client, expLedger), 0n);
      r.outcome = "success";
    }));

  it("rejects an amount over the ceiling", () =>
    scenario(kind, "rejects an amount over the ceiling", "AmountExceedsMax (#2)", async (r) => {
      const t = terms(kind);
      const auth = await clientSign(t, world.client, expLedger);
      await expectRefused(r, settleCall(auth, t, MAX + 1n), CONTRACT(2));
    }));

  it("rejects a replayed auth entry", () =>
    scenario(kind, "rejects a replayed auth entry", "Error(Auth, ExistingValue)", async (r) => {
      const last = settled.get(kind);
      if (!last) throw new Error("no earlier settlement to replay");
      await expectRefused(r, settleCall(last.auth, last.terms, 1n), REPLAYED);
    }));

  it("rejects a reused nonce with a new signature", () =>
    scenario(kind, "rejects a reused nonce with a new signature", "NonceUsed (#7)", async (r) => {
      const last = settled.get(kind);
      if (!last) throw new Error("no earlier settlement to replay");
      const auth = await clientSignDirect(last.terms, world.client, expLedger);
      await expectRefused(r, settleCall(auth, last.terms, 1n), CONTRACT(7));
    }));

  it("rejects a settlement before valid_after", () =>
    scenario(kind, "rejects a settlement before valid_after", "NotYetValid (#4)", async (r) => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const t = terms(kind, { validAfter: now + 3600n, deadline: now + 7200n });
      const auth = await clientSignDirect(t, world.client, expLedger);
      await expectRefused(r, settleCall(auth, t, 1n), CONTRACT(4));
    }));

  it("rejects a settlement after the deadline", () =>
    scenario(kind, "rejects a settlement after the deadline", "Expired (#5)", async (r) => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const t = terms(kind, { validAfter: now - 7200n, deadline: now - 3600n });
      const auth = await clientSignDirect(t, world.client, expLedger);
      await expectRefused(r, settleCall(auth, t, 1n), CONTRACT(5));
    }));

  it("rejects a different facilitator", () =>
    scenario(kind, "rejects a different facilitator", "Error(Auth, InvalidAction)", async (r) => {
      const t = terms(kind);
      const auth = await clientSign(t, world.client, expLedger);
      await expectRefused(r, settleCall(auth, t, 1n), AUTH_MISMATCH, otherSubmitter);
    }));

  // The facilitator case is sent by the other facilitator, with its own authorization, so only
  // the client's signature can refuse it.
  const tampers: [string, (t: UptoTerms) => Partial<UptoTerms>, () => SettlementSubmitter][] = [
    ["recipient", (t) => ({ to: t.facilitator }), () => submitter],
    ["token", () => ({ token: world.tokens[kind === "sac" ? "sep41" : "sac"] }), () => submitter],
    ["ceiling", (t) => ({ maxAmount: t.maxAmount * 2n }), () => submitter],
    ["nonce", () => ({ nonce: Buffer.alloc(32, 9) }), () => submitter],
    [
      "facilitator",
      () => ({ facilitator: world.otherFacilitator.publicKey() }),
      () => otherSubmitter,
    ],
  ];
  for (const [field, change, via] of tampers) {
    const name = `rejects a changed ${field}`;
    it(name, () =>
      scenario(kind, name, "Error(Auth, InvalidAction)", async (r) => {
        const t = terms(kind);
        const auth = await clientSign(t, world.client, expLedger);
        const tampered = { ...t, ...change(t) };
        expect(() => checkClientAuth(auth, tampered)).toThrow();
        await expectRefused(r, settleCall(auth, t, 1n, tampered), AUTH_MISMATCH, via());
      }),
    );
  }

  it("settles two authorizations one after the other", () =>
    scenario(kind, "settles two authorizations one after the other", "both success", async (r) => {
      const [a, b] = [terms(kind), terms(kind)];
      const [authA, authB] = [
        await clientSign(a, world.client, expLedger),
        await clientSign(b, world.client, expLedger),
      ];
      const first = await settleAndCheck(r, a, authA, 1_000n);
      const second = await settleAndCheck(r, b, authB, 2_000n);
      expect(second.ledger).toBeGreaterThan(first.ledger);
      r.outcome = `success in ledgers ${first.ledger} and ${second.ledger}`;
    }));

  it("settles two authorizations in the same ledger", () =>
    scenario(
      kind,
      "settles two authorizations in the same ledger",
      "both success, one ledger",
      async (r) => {
        // Two parallel submits can straddle a ledger close, so try a few times.
        for (let attempt = 1; ; attempt++) {
          const [a, b] = [terms(kind), terms(kind)];
          const [authA, authB] = [
            await clientSign(a, world.client, expLedger),
            await clientSign(b, world.client, expLedger),
          ];
          checkClientAuth(authA, a);
          checkClientAuth(authB, b);
          // Both are signed before either is sent, so each balance check would see the other's
          // transfer; check the pair as a whole instead.
          const before = await balances(a);
          const [ra, rb] = await Promise.all([
            submitter.submit(settleCall(authA, a, 3_000n)),
            submitter.submit(settleCall(authB, b, 4_000n)),
          ]);
          expect([ra.status, rb.status]).toEqual(["success", "success"]);
          // Which `approve` ran last is unknown, so the allowance is checked for the pair.
          const txs = [
            await checkSettled(r, a, ra.hash!, 3_000n, { allowance: false }),
            await checkSettled(r, b, rb.hash!, 4_000n, { allowance: false }),
          ];
          const left = await allowanceOf(a);
          expect([MAX - 3_000n, MAX - 4_000n]).toContain(left);
          r.leftoverAllowance = String(left);
          const after = await balances(a);
          expect(before.client - after.client).toBe(7_000n);
          expect(after.seller - before.seller).toBe(7_000n);
          expect(new Set(txs.map((tx) => tx.txSource)).size).toBe(2);
          if (txs[0]!.ledger === txs[1]!.ledger) {
            r.outcome = `success, both in ledger ${txs[0]!.ledger} (attempt ${attempt})`;
            return;
          }
          if (attempt === 3) {
            throw new Error(`3 attempts, none landed both settlements in one ledger`);
          }
        }
      },
    ));
});

describe("availability", () => {
  // After a full run the proxy's TTL is at least the contract's own target, less the skip window:
  // the deploy script set it to the network maximum, or, with EXTEND_TTL=0, the settlements
  // extended it themselves.
  it("keeps the proxy's instance and code alive", () =>
    scenario(
      "all",
      "proxy instance and code stay alive",
      `TTL >= ${TTL_EXTEND_TO - TTL_MIN_EXTENSION} ledgers`,
      async (r) => {
        const t = await contractTtls(world.proxy.contractId, world.proxy.wasmHash);
        expect(t.instance).toBeGreaterThanOrEqual(TTL_EXTEND_TO - TTL_MIN_EXTENSION);
        expect(t.code).toBeGreaterThanOrEqual(TTL_EXTEND_TO - TTL_MIN_EXTENSION);
        r.outcome = `instance ${t.instance}, code ${t.code} ledgers left at ledger ${t.latest}`;
      },
    ));
});

describe("fees", () => {
  it("never charges the client", () =>
    scenario("all", "client pays no settlement fee", "client XLM balance unchanged", async (r) => {
      const after = await xlmBalance(world.client.publicKey());
      expect(after).toBe(clientXlmBefore);
      r.outcome = `client XLM unchanged at ${after} stroops`;
    }));
});
