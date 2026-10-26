import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySettlementStore } from "../src/adapters/memory.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import { createReconciler, scheduleReconciliation } from "../src/settlement/reconcile.js";
import { createRecords } from "../src/settlement/records.js";
import { createSettler } from "../src/settlement/settle.js";
import { settlement } from "./port-contracts.js";

// Review findings on PR #57, numbered as in the review comment. Each test states the expected
// behaviour, so it fails on ce282e3 and passes once its finding is fixed. Finding 3 is at the end
// of settle.test.ts, since it needs that file's settler helpers.

const network = "stellar:testnet";
const BUDGET_MS = 30_000;
const NOW = 1_000_000; // ms; 1000 s
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

const landed = (ledger = 4_000) =>
  ({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    ledger,
    resultXdr: { feeCharged: () => ({ toBigInt: () => 41_000n }) },
  }) as unknown as rpc.Api.GetTransactionResponse;

const missing = (latestLedger: number, latestLedgerCloseTime = 0, oldestLedgerCloseTime = 0) =>
  ({
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger,
    latestLedgerCloseTime,
    oldestLedger: 1,
    oldestLedgerCloseTime,
  }) as unknown as rpc.Api.GetTransactionResponse;

/** A reconciler on a memory store with a clock the test moves. */
function setup(getTransaction: (hash: string) => Promise<rpc.Api.GetTransactionResponse>) {
  const store = new MemorySettlementStore();
  const hooks = {
    onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
    onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
  };
  const logger = jsonLogger("error", () => {});
  const metrics = memoryMetrics();
  let clock = NOW;
  const now = () => clock;
  const records = createRecords({ network, store, hooks, logger, metrics, now });
  const reconciler = createReconciler({
    network,
    store,
    rpc: { getTransaction: vi.fn(getTransaction) },
    records,
    logger,
    metrics,
    budgetMs: BUDGET_MS,
    now,
  });
  return { store, records, reconciler, advance: (ms: number) => (clock += ms), now };
}

/** A reconciler on real time (for fake timers) with RPC answers the test can change. */
function scheduled(answers: Record<string, rpc.Api.GetTransactionResponse>) {
  const store = new MemorySettlementStore();
  const hooks = { onFinal: vi.fn(async () => {}), onSuccess: vi.fn(async () => {}) };
  const logger = jsonLogger("error", () => {});
  const metrics = memoryMetrics();
  const records = createRecords({ network, store, hooks, logger, metrics });
  const getTransaction = vi.fn(async (hash: string) => answers[hash]!);
  const reconciler = createReconciler({
    network,
    store,
    rpc: { getTransaction },
    records,
    logger,
    metrics,
    budgetMs: BUDGET_MS,
  });
  const schedule = scheduleReconciliation({ reconciler, records, logger, network });
  return { store, records, reconciler, schedule, getTransaction };
}

describe("finding 1: a live sweep must not expire a record whose rebuilt hash can still land", () => {
  it("keeps the record open when a rebuild is stored while the sweep waits for the RPC", async () => {
    const key = settlement("1").key;
    const ctx: ReturnType<typeof setup> = setup(async (hash) => {
      if (hash !== H1) return missing(100);
      // While the RPC answers for H1, the /settle call is still inside its budget: H1 came back
      // txBadSeq and the pool stores the rebuild H2.
      expect(ctx.now()).toBeLessThan(NOW + BUDGET_MS);
      expect(
        await ctx.store.addHash(key, H2, ctx.now(), { maxTime: 1_090, maxLedger: 9_999 }),
      ).toBe(true);
      // The RPC answers 40 s later (several failover URLs timing out).
      ctx.advance(40_000);
      // H1's own bound (1060 s) has passed, so the network will never take H1.
      return missing(100, 1_070);
    });
    await ctx.store.claim({ ...settlement("1"), createdAt: NOW });
    await ctx.store.addHash(key, H1, NOW, { maxTime: 1_060, maxLedger: 9_999 });
    ctx.advance(29_000);

    await ctx.reconciler.sweep("live");

    expect((await ctx.store.get(key))?.state).not.toBe("expired");
    // H2 then lands: the pool's success must win.
    const { won } = await ctx.records.finish(key, { state: "success", ledger: 5_000 }, "settle");
    expect(won).toBe(true);
  });
});

describe("finding 2: a startup sweep must not expire a record whose rebuilt hash can still land", () => {
  it("keeps the record open when another instance stores a rebuild during the sweep", async () => {
    const key = settlement("1").key;
    const ctx: ReturnType<typeof setup> = setup(async (hash) => {
      if (hash !== H1) return missing(100);
      // The old instance stores its rebuild while the new instance's startup sweep reads H1.
      expect(
        await ctx.store.addHash(key, H2, ctx.now(), { maxTime: 1_090, maxLedger: 9_999 }),
      ).toBe(true);
      return missing(100, 1_061);
    });
    await ctx.store.claim({ ...settlement("1"), createdAt: NOW });
    await ctx.store.addHash(key, H1, NOW, { maxTime: 1_060, maxLedger: 9_999 });
    ctx.advance(25_000);

    await ctx.reconciler.sweep("startup");

    expect((await ctx.store.get(key))?.state).not.toBe("expired");
  });
});

describe("findings 4 and 6: scheduling", () => {
  afterEach(() => vi.useRealTimers());

  it("finding 4: a hash still in its bound at startup is finished once it lands, not 5 minutes later", async () => {
    vi.useFakeTimers();
    const answers: Record<string, rpc.Api.GetTransactionResponse> = { [H1]: missing(100) };
    const t = scheduled(answers);
    const s = { ...settlement("1"), createdAt: Date.now() - 60_000 };
    await t.store.claim(s);
    await t.store.addHash(s.key, H1, Date.now(), {
      maxTime: Math.floor(Date.now() / 1000) + 30,
      maxLedger: 4_010,
    });
    t.schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.schedule.ready()).toBe(true);

    // The dead process's transaction lands a few seconds after the restart.
    answers[H1] = landed();
    await vi.advanceTimersByTimeAsync(60_000);

    expect((await t.store.get(s.key))?.state).toBe("success");
    t.schedule.close();
  });

  it("finding 6: a store failure during an armed sweep gets a sweep after it", async () => {
    vi.useFakeTimers();
    const t = scheduled({});
    const sweep = vi.spyOn(t.reconciler, "sweep");
    const list = t.store.listNonFinal.bind(t.store);
    let release: (() => void) | undefined;
    t.schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    t.store.listNonFinal = async (n) => {
      const records = await list(n);
      await new Promise<void>((resolve) => (release = resolve));
      return records;
    };
    t.records.recordFailed(settlement("1").key, new Error("store down")); // arms a sweep
    await vi.advanceTimersByTimeAsync(1_000); // the armed sweep starts and waits after listing
    expect(sweep).toHaveBeenCalledTimes(2);

    t.records.recordFailed(settlement("2").key, new Error("store down again"));
    release!();
    t.store.listNonFinal = list;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sweep).toHaveBeenCalledTimes(3);
    t.schedule.close();
  });

  it("finding 6: one unmarked key whose read keeps failing doesn't stop the other records", async () => {
    const t = scheduled({ [H1]: landed() });
    const s = settlement("1");
    await t.store.claim(s);
    await t.store.addHash(s.key, H1, Date.now(), {
      maxTime: Math.floor(Date.now() / 1000) + 30,
      maxLedger: 4_010,
    });
    const bad = settlement("2").key;
    t.records.unmarked.add(bad);
    const get = t.store.get.bind(t.store);
    t.store.get = async (key) => {
      if (key === bad) throw new Error("corrupt row");
      return get(key);
    };

    await t.reconciler.sweep("live").catch(() => undefined);

    expect((await t.store.get(s.key))?.state).toBe("success");
  });
});

describe("finding 5: a success committed but reported as an error still runs its hooks", () => {
  it("runs onSuccess and onFinal once a sweep finds the record already success", async () => {
    class CommitThenThrow extends MemorySettlementStore {
      override async transition(...args: Parameters<MemorySettlementStore["transition"]>) {
        const result = await super.transition(...args);
        if (args[2].state === "success") throw new Error("connection reset after COMMIT");
        return result;
      }
    }
    const store = new CommitThenThrow();
    const hooks = {
      beforeSubmit: vi.fn(async () => ({ allow: true })),
      onFinal: vi.fn(async () => {}),
      onSuccess: vi.fn(async () => {}),
    };
    const logger = jsonLogger("error", () => {});
    const metrics = memoryMetrics();
    const records = createRecords({ network, store, hooks, logger, metrics });
    const verified = {
      transaction: { operations: [{ func: {}, auth: [] }] },
      payer: "GPAYER",
      nonce: "7",
      expirationLedger: 1_012,
      currentLedger: 1_000,
    };
    const settle = createSettler({
      network,
      store,
      hooks,
      logger,
      metrics,
      records,
      check: async () => ({ response: { isValid: true, payer: "GPAYER" }, verified }),
      submitter: {
        submit: async (
          _call: unknown,
          opts: { onSigned: (hash: string, bounds: unknown) => Promise<void> },
        ) => {
          await opts.onSigned(H1, { maxTime: 1, maxLedger: 1 });
          return {
            status: "success",
            hash: H1,
            channel: "GC",
            ledger: 1_001,
            feeCharged: 1n,
            attempts: [{ hash: H1, sent: "yes" }],
          };
        },
      },
      maxFeeStroops: 250_000n,
      settleTimeoutMs: 2_000,
      budgetMs: 5_000,
      pollMs: 5,
      storeGraceMs: 20,
    } as unknown as Parameters<typeof createSettler>[0]);
    const requirements = {
      scheme: "exact",
      network,
      asset: "C",
      amount: "1",
      payTo: "G",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const payload = { x402Version: 2, accepted: requirements, payload: { transaction: "not-xdr" } };
    const out = await settle(
      payload as unknown as Parameters<typeof settle>[0],
      requirements as unknown as Parameters<typeof settle>[1],
    );
    expect(out.response.success).toBe(true);
    const key = "stellar:testnet:GPAYER:7";
    expect((await store.get(key))?.state).toBe("success");

    const reconciler = createReconciler({
      network,
      store,
      rpc: {
        getTransaction: async () => {
          throw new Error("unused");
        },
      },
      records,
      logger,
      metrics,
      budgetMs: 5_000,
    });
    await reconciler.sweep("live");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hooks.onSuccess).toHaveBeenCalledTimes(1);
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
  });
});
