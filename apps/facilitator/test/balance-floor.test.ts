import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { accountEntry } from "@stellar-x402/signer-pool/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { createBalanceFloor } from "../src/spend/balance-floor.js";

const account = Keypair.random().publicKey();
/** The default floor, 5 XLM. */
const FLOOR = 50_000_000n;
/** Two base reserves of 0.5 XLM: the minimum balance of an account with no subentries. */
const RESERVE = 10_000_000n;

/**
 * An RPC whose fee account holds `balance` and has `signers` as subentries; `fail` makes a read
 * throw, `undefined` the account missing.
 */
function fakeRpc() {
  const rpc = {
    balance: undefined as bigint | undefined,
    signers: [] as Keypair[],
    fail: false,
    reads: 0,
    getLedgerEntries: async (key: xdr.LedgerKey) => {
      rpc.reads++;
      if (rpc.fail) throw new Error("fetch failed");
      const accountId = key.account().accountId();
      expect(StrKey.encodeEd25519PublicKey(accountId.ed25519())).toBe(account);
      const entries =
        rpc.balance === undefined ? [] : [accountEntry(accountId, 1n, rpc.signers, rpc.balance)];
      return { entries, latestLedger: 1 };
    },
  };
  return rpc;
}

function setup(intervalMs = 30_000, opts: { maxStaleMs?: number; now?: () => number } = {}) {
  const rpc = fakeRpc();
  const lines: string[] = [];
  const metrics = memoryMetrics();
  const floor = createBalanceFloor({
    rpc,
    account,
    floorStroops: FLOOR,
    intervalMs,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
    ...(opts.maxStaleMs !== undefined && { maxStaleMs: opts.maxStaleMs }),
    ...(opts.now && { now: opts.now }),
  });
  const events = () => lines.map((line) => JSON.parse(line).event as string);
  return { rpc, floor, events, metrics };
}

describe("createBalanceFloor", () => {
  afterEach(() => vi.useRealTimers());

  it("is below the floor before the first reading (fail closed)", () => {
    expect(setup().floor.below()).toBe(true);
  });

  it("is below when the spendable balance is under the floor, and not at or above it", async () => {
    const { rpc, floor } = setup();
    rpc.balance = FLOOR + RESERVE;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
    rpc.balance = FLOOR + RESERVE - 1n;
    await floor.runOnce();
    expect(floor.below()).toBe(true);
  });

  it("leaves out the reserve each subentry locks, which no fee can spend", async () => {
    const { rpc, floor } = setup();
    rpc.balance = FLOOR + RESERVE;
    rpc.signers = [Keypair.random(), Keypair.random()];
    await floor.runOnce();
    expect(floor.below()).toBe(true);
    rpc.balance = FLOOR + RESERVE + 10_000_000n;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
  });

  it("keeps the last reading when a read fails or finds no account, and counts it", async () => {
    const { rpc, floor, events, metrics } = setup();
    rpc.balance = 2n * FLOOR;
    await floor.runOnce();
    rpc.fail = true;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
    rpc.fail = false;
    rpc.balance = undefined;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
    expect(events().filter((event) => event === "balance_read_failed")).toHaveLength(2);
    expect(metrics.value("balance_read_failures_total")).toBe(2);
  });

  it("stays below while no read has succeeded", async () => {
    const { rpc, floor } = setup();
    rpc.fail = true;
    await floor.runOnce();
    expect(floor.below()).toBe(true);
  });

  it("goes below when the last successful reading is older than the staleness bound (0024)", async () => {
    const clock = { now: 1_000_000 };
    const { rpc, floor } = setup(1_000, { maxStaleMs: 10_000, now: () => clock.now });
    rpc.balance = 2n * FLOOR;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
    rpc.fail = true;
    clock.now += 9_999; // a failed read keeps the reading, and it is not stale yet
    await floor.runOnce();
    expect(floor.below()).toBe(false);
    clock.now += 2; // now past maxStaleMs since the last success: fail closed
    expect(floor.below()).toBe(true);
    // A fresh successful reading clears it.
    rpc.fail = false;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
  });

  it("logs once when the reading goes stale, and once when a read refreshes it (0024)", async () => {
    const clock = { now: 1_000_000 };
    const { rpc, floor, events } = setup(1_000, { maxStaleMs: 10_000, now: () => clock.now });
    rpc.balance = 2n * FLOOR;
    await floor.runOnce();
    rpc.fail = true;
    clock.now += 10_001;
    // The failing read sees it first, with no payment asking.
    await floor.runOnce();
    expect(floor.below()).toBe(true);
    await floor.runOnce();
    expect(floor.below()).toBe(true);
    rpc.fail = false;
    await floor.runOnce();
    expect(floor.below()).toBe(false);
    expect(events().filter((event) => event !== "balance_read_failed")).toEqual([
      "facilitator_funded",
      "facilitator_balance_stale",
      "facilitator_balance_fresh",
    ]);
  });

  it("logs a stale reading at the first check that finds it, between reads", () => {
    const clock = { now: 0 };
    const { rpc, floor, events } = setup(1_000, { maxStaleMs: 10_000, now: () => clock.now });
    rpc.balance = 2n * FLOOR;
    return floor.runOnce().then(() => {
      clock.now += 10_001;
      expect(floor.below()).toBe(true);
      expect(floor.below()).toBe(true);
      expect(events()).toEqual(["facilitator_funded", "facilitator_balance_stale"]);
    });
  });

  it("logs the first reading, then once on each crossing", async () => {
    const { rpc, floor, events } = setup();
    for (const balance of [2n * FLOOR, 3n * FLOOR, FLOOR - 1n, 1n, FLOOR + RESERVE]) {
      rpc.balance = balance;
      await floor.runOnce();
    }
    expect(events()).toEqual([
      "facilitator_funded",
      "facilitator_underfunded",
      "facilitator_funded",
    ]);
  });

  it("logs a first reading under the floor as underfunded", async () => {
    const { rpc, floor, events } = setup();
    rpc.balance = 1n;
    await floor.runOnce();
    expect(events()).toEqual(["facilitator_underfunded"]);
  });

  it("reads at start, then every interval until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { rpc, floor } = setup(1_000);
    rpc.balance = 2n * FLOOR;
    await floor.start();
    expect(rpc.reads).toBe(1);
    expect(floor.below()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rpc.reads).toBe(4);
    floor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.reads).toBe(4);
  });
});
