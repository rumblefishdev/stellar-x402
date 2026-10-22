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
import { describe, expect, it, vi } from "vitest";
import { MemorySettlementStore } from "../src/adapters/memory.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { AttemptBounds, SettlementKey } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import { createReconciler } from "../src/settlement/reconcile.js";
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

const missing = (latestLedger: number, latestLedgerCloseTime = 0) =>
  ({
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedger,
    latestLedgerCloseTime,
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
      const { store, reconciler } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep("startup")).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      answers[A] = missing(4_010);
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
      await reconciler.sweep("live");
      expect((await store.get(key))?.state).toBe("expired");
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

    it("runs one sweep at a time", async () => {
      const { store, reconciler, getTransaction } = setup();
      await signed(store, [A]);
      const [first, second] = await Promise.all([
        reconciler.sweep("startup"),
        reconciler.sweep("live"),
      ]);
      expect(first).toBe(second);
      expect(getTransaction).toHaveBeenCalledTimes(1);
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
