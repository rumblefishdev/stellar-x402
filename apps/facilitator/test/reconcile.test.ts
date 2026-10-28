import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { AttemptBounds, SettlementKey, SettlementStore } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import {
  SWEEP_INTERVAL_MS,
  createReconciler,
  scheduleReconciliation,
} from "../src/settlement/reconcile.js";
import { createRecords } from "../src/settlement/records.js";
import { SETTLE_REASONS } from "../src/settlement/settle.js";
import { settlement } from "./port-contracts.js";
import { testDatabase } from "./database.js";

const db = testDatabase();
beforeEach(db.empty);

// Reconciliation (task 0019): each decision's rule has a test here that fails without it.

const network = "stellar:testnet";
const BUDGET_MS = 30_000;
const NOW = 1_000_000;
const A = "a".repeat(64);
const B = "b".repeat(64);
const AUTH_EXPIRY = 5_000;

/** A payload whose auth entry expires at `AUTH_EXPIRY`, the bound of a hash stored without one. */
function payloadWithAuth(): PaymentPayload {
  const payer = Keypair.random().publicKey();
  const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(payer).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: AUTH_EXPIRY,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(asset).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
  const tx = new TransactionBuilder(new Account(payer, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: asset,
        function: "transfer",
        args: [nativeToScVal(payer, { type: "address" })],
        auth: [entry],
      }),
    )
    .setTimeout(0)
    .build();
  return { ...settlement("1").paymentPayload, payload: { transaction: tx.toXDR() } };
}

const landed = (status: "SUCCESS" | "FAILED", ledger = 4_000) =>
  ({
    status: rpc.Api.GetTransactionStatus[status],
    ledger,
    resultXdr: { feeCharged: () => ({ toBigInt: () => 41_000n }) },
  }) as unknown as rpc.Api.GetTransactionResponse;

/** `NOT_FOUND`; by default the RPC's history reaches back before every record. */
const missing = (latestLedger: number, latestLedgerCloseTime = 0, oldestLedgerCloseTime = 0) =>
  ({
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger,
    latestLedgerCloseTime,
    oldestLedger: 1,
    oldestLedgerCloseTime,
  }) as unknown as rpc.Api.GetTransactionResponse;

function setup(answers: Record<string, rpc.Api.GetTransactionResponse | Error> = {}) {
  const store = db.stores().settlements;
  const hooks = {
    onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
    onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
  };
  const lines: string[] = [];
  const logger = jsonLogger("debug", (line) => lines.push(line));
  const metrics = memoryMetrics();
  let clock = NOW;
  const now = () => clock;
  const records = createRecords({ network, store, hooks, logger, metrics, now });
  const getTransaction = vi.fn(async (hash: string) => {
    const answer = answers[hash] ?? missing(1);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const reconciler = createReconciler({
    network,
    store,
    rpc: { getTransaction },
    records,
    logger,
    metrics,
    budgetMs: BUDGET_MS,
    now,
  });
  const advance = (ms: number) => (clock += ms);
  return { store, hooks, lines, metrics, records, reconciler, getTransaction, advance };
}

async function claimed(store: SettlementStore, nonce = "1", createdAt = NOW) {
  const s = { ...settlement(nonce), createdAt };
  await store.claim(s);
  return s.key;
}

async function signed(
  store: SettlementStore,
  hashes: string[],
  bounds: AttemptBounds = { maxTime: 2_000, maxLedger: 4_010 },
  nonce = "1",
) {
  const key = await claimed(store, nonce);
  for (const hash of hashes) await store.addHash(key, hash, NOW, bounds);
  return key;
}

describe("createReconciler", () => {
  describe("claims with no hash", () => {
    it("closes one past its budget plus margin as interrupted, and runs onFinal (decisions 2, 13)", async () => {
      const { store, hooks, reconciler, advance } = setup();
      const key = await claimed(store);
      advance(BUDGET_MS + 5_001);
      expect(await reconciler.sweep()).toMatchObject({ rejected: 1 });
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.interrupted,
      });
      expect(hooks.onFinal).toHaveBeenCalledWith(
        expect.objectContaining({ key, state: "rejected" }),
        "resolved",
      );
    });

    it("leaves one inside its budget plus margin, also the first sweep after a start (decision 27)", async () => {
      const { store, reconciler, advance } = setup();
      const key = await claimed(store);
      advance(BUDGET_MS + 5_000);
      expect(await reconciler.sweep()).toMatchObject({ rejected: 0, open: 1 });
      expect((await store.get(key))?.state).toBe("claimed");
      advance(1);
      expect(await reconciler.sweep()).toMatchObject({ rejected: 1 });
    });

    it("never closes a claim that got its hash meanwhile: addHash wins", async () => {
      const { store, reconciler, advance } = setup();
      const key = await claimed(store);
      advance(BUDGET_MS + 5_001);
      const list = store.listNonFinal.bind(store);
      store.listNonFinal = async (n) => {
        const listed = await list(n);
        // The call signs between the listing and the close.
        await store.addHash(key, A, NOW, { maxTime: 2_000 });
        return listed;
      };
      await reconciler.sweep();
      expect(await store.get(key)).toMatchObject({ state: "signed", hashes: [A] });
    });
  });

  describe("signed records", () => {
    it("finishes a landed success with its ledger and fee, onSuccess, and leaves it unmarked (decision 9)", async () => {
      const { store, hooks, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ success: 1 });
      const record = await store.get(key);
      expect(record).toMatchObject({ state: "success", ledger: 4_000, feeCharged: 41_000n });
      // Nothing says the client got this success: a repeat still gets it.
      expect(record?.successAnsweredAt).toBeUndefined();
      expect((await store.attempts(key))[0]?.state).toBe("landed");
      expect(hooks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ key }), "resolved");
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      expect(metrics.value("settlement_reconciled_total", { state: "success" })).toBe(1);
    });

    it("marks a success answered when this process sent it during the outage (decision 9)", async () => {
      const { store, reconciler, records } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      records.answeredHere.add(key);
      records.unmarked.add(key);
      await reconciler.sweep();
      expect((await store.get(key))?.successAnsweredAt).toBe(NOW);
      expect(records.unmarked.has(key)).toBe(false);
      expect(records.answeredHere.has(key)).toBe(false);
    });

    it("retries the mark of a stored success whose mark failed", async () => {
      const { store, reconciler, records } = setup();
      const key = await signed(store, [A]);
      await store.transition(key, "signed", { state: "success", updatedAt: NOW });
      records.answeredHere.add(key);
      records.unmarked.add(key);
      await reconciler.sweep();
      expect((await store.get(key))?.successAnsweredAt).toBe(NOW);
      expect(records.unmarked.size).toBe(0);
    });

    it("finishes a landed failure as failed", async () => {
      const { store, reconciler } = setup({ [A]: landed("FAILED") });
      const key = await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ failed: 1 });
      expect(await store.get(key)).toMatchObject({
        state: "failed",
        errorReason: SETTLE_REASONS.failed,
      });
    });

    it("keeps a hash the network doesn't know open until its ledger bound passes (decision 1)", async () => {
      const answers = { [A]: missing(4_009) };
      const { store, reconciler, advance } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      answers[A] = missing(4_010);
      advance(BUDGET_MS + 5_001);
      expect(await reconciler.sweep()).toMatchObject({ expired: 1 });
      expect(await store.get(key)).toMatchObject({
        state: "expired",
        errorReason: SETTLE_REASONS.expired,
      });
      expect((await store.attempts(key))[0]?.state).toBe("dead");
    });

    it("keeps a hash bounded by its ledger alone open past 60 s, until that ledger passes (0073)", async () => {
      // No time bound since 0073: a close time long past signing doesn't expire it.
      const answers = { [A]: missing(4_009, NOW / 1000 + 300) };
      const { store, reconciler, advance } = setup(answers);
      const key = await signed(store, [A], { maxLedger: 4_010 });
      advance(BUDGET_MS + 5_001);
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      expect((await store.get(key))?.state).toBe("signed");
      answers[A] = missing(4_010, NOW / 1000 + 305);
      expect(await reconciler.sweep()).toMatchObject({ expired: 1 });
    });

    it("expires a hash once the close time passes its time bound", async () => {
      const { store, reconciler } = setup({ [A]: missing(100, 2_001) });
      const key = await signed(store, [A]);
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("expired");
    });

    it("expires a record only once every hash is dead (decision 5)", async () => {
      const answers = { [A]: missing(4_010), [B]: missing(4_010) };
      const { store, reconciler } = setup(answers);
      const key = await signed(store, [A]);
      await store.addHash(key, B, NOW, { maxTime: 9_999, maxLedger: 4_020 });
      expect(await reconciler.sweep()).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      expect((await store.attempts(key)).map((a) => a.state)).toEqual(["dead", "stored"]);
      answers[B] = missing(4_020);
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("expired");
    });

    it("keeps a record open while the RPC's history doesn't reach back to it, and reports it once (decision 22)", async () => {
      // The oldest ledger the RPC keeps closed after the claim: a landed hash would be NOT_FOUND too.
      const answers = { [A]: missing(4_010, 0, NOW / 1000 + 1) };
      const { store, reconciler, lines, metrics, advance } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("signed");
      expect((await store.attempts(key))[0]?.state).toBe("stored");
      expect(lines.filter((line) => line.includes('"settlement_history_gone"'))).toHaveLength(1);
      expect(metrics.value("settlement_history_gone_total")).toBe(1);
      // History from the claim on: NOT_FOUND past the bound now means it never landed.
      answers[A] = missing(4_010, 0, NOW / 1000);
      // Checked again only every 5 minutes (decision 27).
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      advance(5 * 60_000);
      expect(await reconciler.sweep()).toMatchObject({ expired: 1 });
    });

    it("doesn't expire a record when a rebuild stores a hash during the sweep (decision 26)", async () => {
      const answers: Record<string, rpc.Api.GetTransactionResponse> = {
        [A]: missing(4_010),
        [B]: landed("SUCCESS"),
      };
      const { store, reconciler, getTransaction, advance } = setup(answers);
      const key = await signed(store, [A]);
      // Past the budget, so no time rule holds the write back: only the version does.
      advance(BUDGET_MS + 60_000);
      // The call's `txBadSeq` rebuild is stored while the sweep waits for the RPC.
      getTransaction.mockImplementationOnce(async () => {
        await store.addHash(key, B, NOW, { maxTime: NOW / 1000 + 60 });
        return answers[A]!;
      });
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      expect((await store.get(key))?.state).toBe("signed");
      // The dead hash is written anyway, and the next sweep finds the rebuild landed.
      expect((await store.attempts(key))[0]?.state).toBe("dead");
      expect(await reconciler.sweep()).toMatchObject({ success: 1 });
    });

    it("finishes by the hash that landed, also when another died (decision 5)", async () => {
      const { store, reconciler } = setup({ [A]: missing(4_010), [B]: landed("SUCCESS") });
      const key = await signed(store, [A, B]);
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("success");
      expect((await store.attempts(key)).map((a) => a.state)).toEqual(["dead", "landed"]);
    });

    it("falls back to the auth entry's expiry for a hash stored without bounds (decision 6)", async () => {
      const answers = { [A]: missing(AUTH_EXPIRY - 1) };
      const { store, reconciler } = setup(answers);
      const s = { ...settlement("1"), paymentPayload: payloadWithAuth(), createdAt: NOW };
      await store.claim(s);
      await store.addHash(s.key, A, NOW);
      await reconciler.sweep();
      expect((await store.get(s.key))?.state).toBe("signed");
      answers[A] = missing(AUTH_EXPIRY);
      await reconciler.sweep();
      expect((await store.get(s.key))?.state).toBe("expired");
    });

    it("counts a record whose RPC call fails, leaves it, and goes on with the others", async () => {
      const { store, reconciler, lines } = setup({
        [A]: new Error("rpc down"),
        [B]: landed("SUCCESS"),
      });
      const k1 = await signed(store, [A], undefined, "1");
      const k2 = await signed(store, [B], undefined, "2");
      expect(await reconciler.sweep()).toMatchObject({ errors: 1, success: 1 });
      expect((await store.get(k1))?.state).toBe("signed");
      expect((await store.get(k2))?.state).toBe("success");
      expect(lines.some((line) => line.includes('"settlement_reconcile_failed"'))).toBe(true);
    });

    it("runs onSuccess when the answered mark fails, and counts the record as an error", async () => {
      const { store, hooks, reconciler, records } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      records.answeredHere.add(key);
      records.unmarked.add(key);
      vi.spyOn(store, "markSuccessAnswered").mockRejectedValueOnce(new Error("store down"));
      expect(await reconciler.sweep()).toMatchObject({ errors: 1 });
      expect((await store.get(key))?.state).toBe("success");
      expect(hooks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ key }), "resolved");
      // The next sweep marks it.
      await reconciler.sweep();
      expect((await store.get(key))?.successAnsweredAt).toBe(NOW);
    });
  });

  describe("writes that threw (decision 29)", () => {
    it("runs the hooks of a final write that committed but threw, once", async () => {
      const { store, hooks, reconciler } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      const transition = store.transition.bind(store);
      vi.spyOn(store, "transition").mockImplementationOnce(async (...args) => {
        await transition(...args);
        throw new Error("connection lost after commit");
      });
      expect(await reconciler.sweep()).toMatchObject({ errors: 1 });
      expect((await store.get(key))?.state).toBe("success");
      expect(hooks.onFinal).not.toHaveBeenCalled();
      await reconciler.sweep();
      await reconciler.sweep();
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      expect(hooks.onFinal).toHaveBeenCalledWith(
        expect.objectContaining({ key, state: "success" }),
        "resolved",
      );
      expect(hooks.onSuccess).toHaveBeenCalledTimes(1);
    });

    it("leaves one that didn't commit to the writer that finishes it, so its hooks run once", async () => {
      const { store, hooks, records, reconciler } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("store down"));
      expect(await reconciler.sweep()).toMatchObject({ errors: 1 });
      expect(records.unconfirmed.has(key)).toBe(true);
      expect(await reconciler.sweep()).toMatchObject({ success: 1 });
      expect(records.unconfirmed.has(key)).toBe(false);
      await reconciler.sweep();
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
    });

    it("goes on with the sweep when one key can't be read", async () => {
      const { store, records, reconciler, lines } = setup({ [B]: landed("SUCCESS") });
      const bad = settlement("9").key;
      records.unmarked.add(bad);
      records.unconfirmed.add(bad);
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (key) => {
        if (key === bad) throw new Error("bad row");
        return get(key);
      });
      const key = await signed(store, [B], undefined, "2");
      expect(await reconciler.sweep()).toMatchObject({ success: 1 });
      expect((await store.get(key))?.state).toBe("success");
      expect(lines.filter((line) => line.includes('"settlement_reconcile_failed"'))).toHaveLength(
        2,
      );
    });
  });

  describe("the pool's resolved event", () => {
    it("finishes a pending record from the pool's result, with its attempts", async () => {
      const { store, hooks, reconciler } = setup();
      const key = await signed(store, [A, B]);
      await store.transition(key, "signed", { state: "pending", updatedAt: NOW });
      await reconciler.resolved({
        status: "success",
        hash: B,
        channel: "GCHANNEL",
        ledger: 4_001,
        feeCharged: 41_000n,
        attempts: [
          { hash: A, sent: "yes" },
          { hash: B, sent: "yes" },
        ],
      });
      expect(await store.get(key)).toMatchObject({
        state: "success",
        ledger: 4_001,
        channel: "GCHANNEL",
      });
      expect((await store.attempts(key)).map((a) => [a.state, a.errorCode])).toEqual([
        ["dead", "txBadSeq"],
        ["landed", undefined],
      ]);
      expect(hooks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ key }), "resolved");
    });

    it("finishes an expired one with its reason", async () => {
      const { store, reconciler } = setup();
      const key: SettlementKey = await signed(store, [A]);
      await reconciler.resolved({
        status: "expired",
        hash: A,
        channel: "GCHANNEL",
        attempts: [{ hash: A, sent: "yes" }],
      });
      expect(await store.get(key)).toMatchObject({
        state: "expired",
        errorReason: SETTLE_REASONS.expired,
      });
    });
  });
});

describe("scheduleReconciliation (decision 27)", () => {
  afterEach(() => vi.useRealTimers());

  function scheduled(t = setup(), lines: string[] = []) {
    const sweep = vi.spyOn(t.reconciler, "sweep");
    const schedule = scheduleReconciliation({
      reconciler: t.reconciler,
      logger: jsonLogger("warn", (line) => lines.push(line)),
      network,
    });
    return { ...t, sweep, schedule, lines };
  }

  it("sweeps at start and then every interval after a sweep ends", async () => {
    vi.useFakeTimers();
    const { schedule, sweep } = scheduled();
    schedule.start();
    await schedule.reconciled;
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    schedule.close();
    await vi.advanceTimersByTimeAsync(10 * SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("finishes a payment that landed while the process was down within one interval", async () => {
    vi.useFakeTimers();
    const answers: Record<string, rpc.Api.GetTransactionResponse | Error> = {
      [A]: missing(1),
    };
    const t = setup(answers);
    const key = await signed(t.store, [A]);
    const { schedule, sweep } = scheduled(t);
    schedule.start();
    await schedule.reconciled;
    expect((await t.store.get(key))?.state).toBe("signed");
    // Not yet in a ledger at start: the next sweep, not a 5-minute one, finds it.
    answers[A] = landed("SUCCESS");
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await sweep.mock.results.at(-1)?.value;
    expect((await t.store.get(key))?.state).toBe("success");
    schedule.close();
  });

  it("logs a sweep that fails, settles reconciled, and sweeps again", async () => {
    vi.useFakeTimers();
    const t = setup();
    const list = t.store.listNonFinal.bind(t.store);
    let down = 1;
    t.store.listNonFinal = async (n) => {
      if (down-- > 0) throw new Error("store down");
      return list(n);
    };
    const { schedule, sweep, lines } = scheduled(t);
    schedule.start();
    await schedule.reconciled;
    expect(lines.filter((line) => line.includes('"reconcile_failed"'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    await expect(sweep.mock.results[1]?.value).resolves.toMatchObject({ errors: 0 });
    schedule.close();
  });

  it("reports listed once a sweep lists the records, not after one that failed (decision 36)", async () => {
    vi.useFakeTimers();
    const t = setup();
    const list = t.store.listNonFinal.bind(t.store);
    let down = 1;
    t.store.listNonFinal = async (n) => {
      if (down-- > 0) throw new Error("store down");
      return list(n);
    };
    const { schedule, sweep } = scheduled(t);
    expect(schedule.listed()).toBe(false);
    schedule.start();
    await schedule.reconciled;
    expect(schedule.listed()).toBe(false);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await sweep.mock.results.at(-1)?.value;
    expect(schedule.listed()).toBe(true);
    // A later failure doesn't take it back.
    t.store.listNonFinal = async () => {
      throw new Error("store down");
    };
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await sweep.mock.results.at(-1)?.value.catch(() => {});
    expect(schedule.listed()).toBe(true);
    schedule.close();
  });

  it("reports listed before the sweep's records are checked", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signed(t.store, [A]);
    let release!: () => void;
    t.getTransaction.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(missing(1)))),
    );
    const { schedule } = scheduled(t);
    schedule.start();
    await vi.waitFor(() => expect(t.getTransaction).toHaveBeenCalled());
    expect(schedule.listed()).toBe(true);
    release();
    await schedule.reconciled;
    schedule.close();
  });

  it("waits on close() for a sweep under way, and starts none after it (0025)", async () => {
    vi.useFakeTimers();
    const { store, schedule, sweep } = scheduled();
    const list = store.listNonFinal.bind(store);
    let release!: () => void;
    store.listNonFinal = async (n) => {
      await new Promise<void>((resolve) => (release = resolve));
      return list(n);
    };
    schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const closing = schedule.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(10 * SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("checks a record whose history is gone only every 5 minutes", async () => {
    vi.useFakeTimers();
    // Past its bound, and the RPC's history starts after the record was made.
    const t = setup({ [A]: missing(4_010, 0, NOW / 1000 + 1) });
    await signed(t.store, [A]);
    const { schedule, sweep } = scheduled(t);
    // The store's queries take real time: wait for the sweep a tick started.
    const tick = async () => {
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      await sweep.mock.results.at(-1)?.value;
    };
    schedule.start();
    await schedule.reconciled;
    expect(t.getTransaction).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) await tick();
    expect(sweep.mock.calls.length).toBeGreaterThan(1);
    expect(t.getTransaction).toHaveBeenCalledTimes(1);
    t.advance(5 * 60_000);
    await tick();
    expect(t.getTransaction).toHaveBeenCalledTimes(2);
    schedule.close();
  });
});
