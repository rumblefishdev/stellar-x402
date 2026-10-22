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
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySettlementStore } from "../src/adapters/memory.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { AttemptBounds, SettlementKey } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import { createReconciler, scheduleReconciliation } from "../src/settlement/reconcile.js";
import { createRecords } from "../src/settlement/records.js";
import { SETTLE_REASONS } from "../src/settlement/settle.js";
import { settlement } from "./port-contracts.js";

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
  const store = new MemorySettlementStore();
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

async function claimed(store: MemorySettlementStore, nonce = "1", createdAt = NOW) {
  const s = { ...settlement(nonce), createdAt };
  await store.claim(s);
  return s.key;
}

async function signed(
  store: MemorySettlementStore,
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
    it("closes every one at startup as interrupted, and runs onFinal (decision 2)", async () => {
      const { store, hooks, reconciler } = setup();
      const key = await claimed(store);
      expect(await reconciler.sweep("startup")).toMatchObject({ rejected: 1 });
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.interrupted,
      });
      expect(hooks.onFinal).toHaveBeenCalledWith(
        expect.objectContaining({ key, state: "rejected" }),
        "resolved",
      );
    });

    it("leaves one inside its budget plus margin in a live sweep, and closes it after (decision 13)", async () => {
      const { store, reconciler, advance } = setup();
      const key = await claimed(store);
      advance(BUDGET_MS + 5_000);
      expect(await reconciler.sweep("live")).toMatchObject({ rejected: 0, open: 1 });
      expect((await store.get(key))?.state).toBe("claimed");
      advance(1);
      expect(await reconciler.sweep("live")).toMatchObject({ rejected: 1 });
    });

    it("never closes a claim that got its hash meanwhile: addHash wins", async () => {
      const { store, reconciler } = setup();
      const key = await claimed(store);
      const list = store.listNonFinal.bind(store);
      store.listNonFinal = async (n) => {
        const listed = await list(n);
        // The call signs between the listing and the close.
        await store.addHash(key, A, NOW, { maxTime: 2_000 });
        return listed;
      };
      await reconciler.sweep("startup");
      expect(await store.get(key)).toMatchObject({ state: "signed", hashes: [A] });
    });
  });

  describe("signed records", () => {
    it("finishes a landed success with its ledger and fee, onSuccess, and leaves it unmarked (decision 9)", async () => {
      const { store, hooks, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      expect(await reconciler.sweep("startup")).toMatchObject({ success: 1 });
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
      await reconciler.sweep("live");
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
      await reconciler.sweep("live");
      expect((await store.get(key))?.successAnsweredAt).toBe(NOW);
      expect(records.unmarked.size).toBe(0);
    });

    it("finishes a landed failure as failed", async () => {
      const { store, reconciler } = setup({ [A]: landed("FAILED") });
      const key = await signed(store, [A]);
      expect(await reconciler.sweep("startup")).toMatchObject({ failed: 1 });
      expect(await store.get(key)).toMatchObject({
        state: "failed",
        errorReason: SETTLE_REASONS.failed,
      });
    });

    it("keeps a hash the network doesn't know open until its ledger bound passes (decision 1)", async () => {
      const answers = { [A]: missing(4_009) };
      const { store, reconciler, advance } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep("startup")).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      answers[A] = missing(4_010);
      advance(BUDGET_MS + 5_001);
      expect(await reconciler.sweep("live")).toMatchObject({ expired: 1 });
      expect(await store.get(key)).toMatchObject({
        state: "expired",
        errorReason: SETTLE_REASONS.expired,
      });
      expect((await store.attempts(key))[0]?.state).toBe("dead");
    });

    it("expires a hash once the close time passes its time bound", async () => {
      const { store, reconciler } = setup({ [A]: missing(100, 2_001) });
      const key = await signed(store, [A]);
      await reconciler.sweep("startup");
      expect((await store.get(key))?.state).toBe("expired");
    });

    it("expires a record only once every hash is dead (decision 5)", async () => {
      const answers = { [A]: missing(4_010), [B]: missing(4_010) };
      const { store, reconciler } = setup(answers);
      const key = await signed(store, [A]);
      await store.addHash(key, B, NOW, { maxTime: 9_999, maxLedger: 4_020 });
      expect(await reconciler.sweep("startup")).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      expect((await store.attempts(key)).map((a) => a.state)).toEqual(["dead", "stored"]);
      answers[B] = missing(4_020);
      await reconciler.sweep("startup");
      expect((await store.get(key))?.state).toBe("expired");
    });

    it("keeps a record open while the RPC's history doesn't reach back to it, and reports it once (decision 22)", async () => {
      // The oldest ledger the RPC keeps closed after the claim: a landed hash would be NOT_FOUND too.
      const answers = { [A]: missing(4_010, 0, NOW / 1000 + 1) };
      const { store, reconciler, lines, metrics } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep("startup")).toMatchObject({ open: 1, expired: 0 });
      await reconciler.sweep("startup");
      expect((await store.get(key))?.state).toBe("signed");
      expect((await store.attempts(key))[0]?.state).toBe("stored");
      expect(lines.filter((line) => line.includes('"settlement_history_gone"'))).toHaveLength(1);
      expect(metrics.value("settlement_history_gone_total")).toBe(1);
      // History from the claim on: NOT_FOUND past the bound now means it never landed.
      answers[A] = missing(4_010, 0, NOW / 1000);
      expect(await reconciler.sweep("startup")).toMatchObject({ expired: 1 });
    });

    it("doesn't expire a record in a live sweep while its call may still store a hash (decision 23)", async () => {
      const { store, reconciler, advance } = setup({ [A]: missing(4_010) });
      const key = await signed(store, [A]);
      advance(BUDGET_MS + 5_000);
      expect(await reconciler.sweep("live")).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      // The dead hash is written anyway.
      expect((await store.attempts(key))[0]?.state).toBe("dead");
      advance(1);
      expect(await reconciler.sweep("live")).toMatchObject({ expired: 1 });
    });

    it("finishes by the hash that landed, also when another died (decision 5)", async () => {
      const { store, reconciler } = setup({ [A]: missing(4_010), [B]: landed("SUCCESS") });
      const key = await signed(store, [A, B]);
      await reconciler.sweep("startup");
      expect((await store.get(key))?.state).toBe("success");
      expect((await store.attempts(key)).map((a) => a.state)).toEqual(["dead", "landed"]);
    });

    it("falls back to the auth entry's expiry for a hash stored without bounds (decision 6)", async () => {
      const answers = { [A]: missing(AUTH_EXPIRY - 1) };
      const { store, reconciler } = setup(answers);
      const s = { ...settlement("1"), paymentPayload: payloadWithAuth(), createdAt: NOW };
      await store.claim(s);
      await store.addHash(s.key, A, NOW);
      await reconciler.sweep("startup");
      expect((await store.get(s.key))?.state).toBe("signed");
      answers[A] = missing(AUTH_EXPIRY);
      await reconciler.sweep("startup");
      expect((await store.get(s.key))?.state).toBe("expired");
    });

    it("counts a record whose RPC call fails, leaves it, and goes on with the others", async () => {
      const { store, reconciler, lines } = setup({
        [A]: new Error("rpc down"),
        [B]: landed("SUCCESS"),
      });
      const k1 = await signed(store, [A], undefined, "1");
      const k2 = await signed(store, [B], undefined, "2");
      expect(await reconciler.sweep("startup")).toMatchObject({ errors: 1, success: 1 });
      expect((await store.get(k1))?.state).toBe("signed");
      expect((await store.get(k2))?.state).toBe("success");
      expect(lines.some((line) => line.includes('"settlement_reconcile_failed"'))).toBe(true);
    });

    it("runs one sweep at a time: calls during one share the next, which starts after it", async () => {
      const { store, reconciler, getTransaction } = setup();
      await signed(store, [A]);
      let inFlight = 0;
      let most = 0;
      getTransaction.mockImplementation(async () => {
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return missing(1);
      });
      const [first, second, third] = await Promise.all([
        reconciler.sweep("startup"),
        reconciler.sweep("live"),
        reconciler.sweep("live"),
      ]);
      expect(first).not.toBe(second);
      expect(second).toBe(third);
      expect(getTransaction).toHaveBeenCalledTimes(2);
      expect(most).toBe(1);
    });

    it("runs onSuccess when the answered mark fails, and counts the record as an error", async () => {
      const { store, hooks, reconciler, records } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      records.answeredHere.add(key);
      records.unmarked.add(key);
      vi.spyOn(store, "markSuccessAnswered").mockRejectedValueOnce(new Error("store down"));
      expect(await reconciler.sweep("live")).toMatchObject({ errors: 1 });
      expect((await store.get(key))?.state).toBe("success");
      expect(hooks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ key }), "resolved");
      // The next sweep marks it.
      await reconciler.sweep("live");
      expect((await store.get(key))?.successAnsweredAt).toBe(NOW);
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

describe("scheduleReconciliation (decisions 4, 8)", () => {
  afterEach(() => vi.useRealTimers());

  function scheduled() {
    const t = setup();
    const sweep = vi.spyOn(t.reconciler, "sweep");
    const schedule = scheduleReconciliation({
      reconciler: t.reconciler,
      records: t.records,
      logger: jsonLogger("error"),
      network,
    });
    return { ...t, sweep, schedule };
  }

  it("retries the startup sweep with backoff until the store answers, then serves", async () => {
    vi.useFakeTimers();
    const { store, schedule, sweep } = scheduled();
    const list = store.listNonFinal.bind(store);
    let down = 2;
    store.listNonFinal = async (n) => {
      if (down-- > 0) throw new Error("store down");
      return list(n);
    };
    schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(schedule.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); // the first retry
    expect(schedule.ready()).toBe(false);
    // The next retry waits twice as long.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(schedule.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(schedule.ready()).toBe(true);
    await schedule.reconciled;
    expect(sweep.mock.calls.map(([mode]) => mode)).toEqual(["startup", "startup", "startup"]);
    schedule.close();
  });

  it("opens /settle once every record was tried, and retries one the RPC couldn't check (decision 21)", async () => {
    vi.useFakeTimers();
    const answers: Record<string, rpc.Api.GetTransactionResponse | Error> = {
      [A]: new Error("rpc down"),
    };
    const t = setup(answers);
    const key = await signed(t.store, [A]);
    const schedule = scheduleReconciliation({
      reconciler: t.reconciler,
      records: t.records,
      logger: jsonLogger("error"),
      network,
    });
    schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(schedule.ready()).toBe(true);
    // Still failing: the retry backs off and tries again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await t.store.get(key))?.state).toBe("signed");
    answers[A] = landed("SUCCESS");
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await t.store.get(key))?.state).toBe("success");
    expect(t.getTransaction).toHaveBeenCalledTimes(3);
    // Checked: no more retries before the 5-minute sweep.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.getTransaction).toHaveBeenCalledTimes(3);
    schedule.close();
  });

  it("sweeps once the store answers after a failed write, and every 5 minutes", async () => {
    vi.useFakeTimers();
    const { schedule, sweep, records } = scheduled();
    schedule.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    // Two failures arm one sweep, a second after.
    records.recordFailed(settlement("1").key, new Error("store down"));
    records.recordFailed(settlement("1").key, new Error("store down"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep.mock.calls.map(([mode]) => mode)).toEqual(["startup", "live"]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(3);
    schedule.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it("stops retrying a record the RPC keeps failing after 5 sweeps; the 5-minute sweep tries again (decision 24)", async () => {
    vi.useFakeTimers();
    const t = setup({ [A]: new Error("rpc down") });
    await signed(t.store, [A]);
    const lines: string[] = [];
    const schedule = scheduleReconciliation({
      reconciler: t.reconciler,
      records: t.records,
      logger: jsonLogger("warn", (line) => lines.push(line)),
      network,
    });
    schedule.start();
    // The startup sweep, then 5 tries: 1 + 2 + 4 + 8 s of backoff between them.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.getTransaction).toHaveBeenCalledTimes(6);
    expect(lines.filter((line) => line.includes('"reconcile_gave_up"'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(t.getTransaction).toHaveBeenCalledTimes(7);
    schedule.close();
  });

  it("starts nothing once closed during the startup sweep", async () => {
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
    schedule.close();
    release();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(schedule.ready()).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("ignores store failures before it serves: the startup sweep retries on its own", async () => {
    vi.useFakeTimers();
    const { schedule, sweep, records } = scheduled();
    records.recordFailed(settlement("1").key, new Error("store down"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).not.toHaveBeenCalled();
    schedule.close();
  });
});
