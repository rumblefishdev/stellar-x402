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
import type { SubmitResult } from "@stellar-x402/signer-pool";
import { failedResult } from "@stellar-x402/signer-pool/testing";
import { holdLease, settlement } from "./port-contracts.js";
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
  for (const hash of hashes) await store.addHash(key, hash, await holdLease(store), NOW, bounds);
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
        await store.addHash(key, A, await holdLease(store), NOW, { maxTime: 2_000 });
        return listed;
      };
      await reconciler.sweep();
      expect(await store.get(key)).toMatchObject({ state: "signed", hashes: [A] });
    });

    it("never closes a claim reopened after the sweep read the earlier one (0073 decision 19)", async () => {
      // The sweep reads the old claim; before its close, a repeat's budget ends it and another
      // repeat reopens it. The reopened claim is still `claimed` with no hash, but it is a new
      // claim whose call may still sign: only the version the sweep read tells them apart.
      const { store, reconciler, advance } = setup();
      const key = await claimed(store);
      advance(BUDGET_MS + 5_001);
      const reason = SETTLE_REASONS.noChannelInTime;
      const list = store.listNonFinal.bind(store);
      store.listNonFinal = async (n) => {
        const listed = await list(n);
        await store.transition(key, "claimed", {
          state: "rejected",
          errorReason: reason,
          updatedAt: NOW,
        });
        const { fingerprint } = settlement("1");
        expect(await store.reopen(key, fingerprint, [reason], NOW)).toBeDefined();
        return listed;
      };
      expect(await reconciler.sweep()).toMatchObject({ rejected: 0 });
      expect(await store.get(key)).toMatchObject({ state: "claimed", reopened: 1, hashes: [] });
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

    it("stores why a landed failure failed", async () => {
      const failed = {
        ...landed("FAILED"),
        resultXdr: failedResult("invokeHostFunctionEntryArchived"),
      } as unknown as rpc.Api.GetTransactionResponse;
      const { store, reconciler } = setup({ [A]: failed });
      const key = await signed(store, [A]);
      await reconciler.sweep();
      expect((await store.get(key))?.failure).toEqual({
        opCode: "invokeHostFunctionEntryArchived",
      });
    });

    it("keeps a hash the network doesn't know open until its ledger bound passes (decision 1)", async () => {
      const answers = { [A]: missing(4_009) };
      const { store, reconciler, advance } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      answers[A] = missing(4_013);
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
      answers[A] = missing(4_013, NOW / 1000 + 305);
      expect(await reconciler.sweep()).toMatchObject({ expired: 1 });
    });

    it.each([4_010, 4_011, 4_012])(
      "doesn't take NOT_FOUND read at ledger %i of a bound at 4010 as dead: it may have landed (0088)",
      async (latestLedger) => {
        const answers = { [A]: missing(latestLedger) };
        const { store, reconciler } = setup(answers);
        const key = await signed(store, [A], { maxLedger: 4_010 });
        expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
        expect((await store.get(key))?.state).toBe("signed");
        expect((await store.attempts(key))[0]?.state).toBe("stored");
        answers[A] = landed("SUCCESS");
        expect(await reconciler.sweep()).toMatchObject({ success: 1 });
        expect((await store.get(key))?.state).toBe("success");
      },
    );

    it("expires a hash once the close time passes its time bound by the margin (0088)", async () => {
      const answers = { [A]: missing(100, 2_015) };
      const { store, reconciler } = setup(answers);
      const key = await signed(store, [A]);
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("signed");
      answers[A] = missing(100, 2_016);
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("expired");
    });

    it("expires a record only once every hash is dead (decision 5)", async () => {
      const answers = { [A]: missing(4_013), [B]: missing(4_013) };
      const { store, reconciler } = setup(answers);
      const key = await signed(store, [A]);
      await store.addHash(key, B, await holdLease(store), NOW, {
        maxTime: 9_999,
        maxLedger: 4_020,
      });
      expect(await reconciler.sweep()).toMatchObject({ open: 1 });
      expect((await store.get(key))?.state).toBe("signed");
      expect((await store.attempts(key)).map((a) => a.state)).toEqual(["dead", "stored"]);
      answers[B] = missing(4_023);
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("expired");
    });

    it("keeps a record open while the RPC's history doesn't reach back to it, and reports it once (decision 22)", async () => {
      // The oldest ledger the RPC keeps closed after the claim: a landed hash would be NOT_FOUND too.
      const answers = { [A]: missing(4_013, 0, NOW / 1000 + 1) };
      const { store, reconciler, lines, metrics, advance } = setup(answers);
      const key = await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      await reconciler.sweep();
      expect((await store.get(key))?.state).toBe("signed");
      expect((await store.attempts(key))[0]?.state).toBe("stored");
      expect(lines.filter((line) => line.includes('"settlement_history_gone"'))).toHaveLength(1);
      expect(metrics.value("settlement_history_gone_total")).toBe(1);
      // History from the claim on: NOT_FOUND past the bound now means it never landed.
      answers[A] = missing(4_013, 0, NOW / 1000);
      // Checked again only every 5 minutes (decision 27).
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      advance(5 * 60_000);
      expect(await reconciler.sweep()).toMatchObject({ expired: 1 });
    });

    it("frees the payer and asset's in-flight slot when a record's history is gone, so the next payment isn't blocked (0024)", async () => {
      // Past its bound (with the NOT_FOUND margin), history starting after the claim: it stays
      // open, but can't land again.
      const answers = { [A]: missing(4_013, 0, NOW / 1000 + 1) };
      const { store, reconciler } = setup(answers);
      const key = await signed(store, [A]);
      const slot = async () =>
        (
          await db.pool.query<{ key: string }>(
            "SELECT key FROM settlement_in_flight WHERE key = $1",
            [key],
          )
        ).rows;
      // The claim took the (network, payer, asset) slot.
      expect(await slot()).toHaveLength(1);
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      // The record stays open for the operator, but the slot is freed: nothing can land past the
      // bound, so another payment of this payer and asset must not be answered `payer_busy` forever.
      expect((await store.get(key))?.state).toBe("signed");
      expect(await slot()).toHaveLength(0);
    });

    it("doesn't expire a record when a rebuild stores a hash during the sweep (decision 26)", async () => {
      const answers: Record<string, rpc.Api.GetTransactionResponse> = {
        [A]: missing(4_013),
        [B]: landed("SUCCESS"),
      };
      const { store, reconciler, getTransaction, advance } = setup(answers);
      const key = await signed(store, [A]);
      // Past the budget, so no time rule holds the write back: only the version does.
      advance(BUDGET_MS + 60_000);
      // The call's `txBadSeq` rebuild is stored while the sweep waits for the RPC.
      getTransaction.mockImplementationOnce(async () => {
        await store.addHash(key, B, await holdLease(store), NOW, { maxTime: NOW / 1000 + 60 });
        return answers[A]!;
      });
      expect(await reconciler.sweep()).toMatchObject({ open: 1, expired: 0 });
      expect((await store.get(key))?.state).toBe("signed");
      // The dead hash is written anyway, and the next sweep finds the rebuild landed.
      expect((await store.attempts(key))[0]?.state).toBe("dead");
      expect(await reconciler.sweep()).toMatchObject({ success: 1 });
    });

    it("finishes by the hash that landed, also when another died (decision 5)", async () => {
      const { store, reconciler } = setup({ [A]: missing(4_013), [B]: landed("SUCCESS") });
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
      await store.addHash(s.key, A, await holdLease(store), NOW);
      await reconciler.sweep();
      expect((await store.get(s.key))?.state).toBe("signed");
      answers[A] = missing(AUTH_EXPIRY);
      await reconciler.sweep();
      expect((await store.get(s.key))?.state).toBe("signed");
      answers[A] = missing(AUTH_EXPIRY + 2);
      await reconciler.sweep();
      expect((await store.get(s.key))?.state).toBe("signed");
      answers[A] = missing(AUTH_EXPIRY + 3);
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
      const { store, hooks, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
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
      // Its fee too, once, with the hooks that confirm it (0027).
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
    });

    it("runs the hooks once when a writer that lost takes the key out while the sweep reads it", async () => {
      const { store, hooks, records, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      const transition = store.transition.bind(store);
      vi.spyOn(store, "transition").mockImplementationOnce(async (...args) => {
        await transition(...args);
        throw new Error("connection lost after commit");
      });
      expect(await reconciler.sweep()).toMatchObject({ errors: 1 });
      expect(records.unconfirmed.has(key)).toBe(true);
      // The next sweep listed the key; while it reads the record, a writer that read it before the
      // commit takes the key out, and its compare-and-set from `signed` loses and puts it back.
      let writer: Promise<unknown> | undefined;
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementationOnce(async (k) => {
        const record = await get(k);
        writer = records.finalWrite(key, () =>
          transition(key, "signed", { state: "success", updatedAt: NOW }),
        );
        return record;
      });
      await reconciler.sweep();
      expect(await writer).toBeUndefined();
      expect(records.unconfirmed.has(key)).toBe(true);
      await reconciler.sweep();
      await reconciler.sweep();
      expect(records.unconfirmed.has(key)).toBe(false);
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      expect(hooks.onSuccess).toHaveBeenCalledTimes(1);
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
    });

    it("forgets the key when a final write wins after a racing one threw without committing", async () => {
      const { store, hooks, records, reconciler, metrics } = setup();
      const key = await signed(store, [A]);
      // Writer 1 takes the key out (it isn't listed), then its write fails without committing.
      let fail!: () => void;
      const failing = new Promise<void>((r) => (fail = r));
      const writer1 = records.finalWrite(key, async () => {
        await failing;
        throw new Error("store down");
      });
      // Writer 2 enters while writer 1 is out, so it finds the key unlisted; its commit lands
      // after writer 1 has put the key back.
      const transition = store.transition.bind(store);
      let commit!: () => void;
      const committing = new Promise<void>((r) => (commit = r));
      const entered = vi.spyOn(store, "transition").mockImplementationOnce(async (...args) => {
        await committing;
        return transition(...args);
      });
      const writer2 = records.finish(
        key,
        { state: "success", ledger: 4_000, feeCharged: 41_000n },
        "settle",
      );
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      fail();
      await expect(writer1).rejects.toThrow("store down");
      expect(records.unconfirmed.has(key)).toBe(true);
      commit();
      expect(await writer2).toMatchObject({ won: true });
      // Writer 2 ran the hooks; no sweep runs them again.
      expect(records.unconfirmed.has(key)).toBe(false);
      await reconciler.sweep();
      await reconciler.sweep();
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      // finish() runs onFinal only; the writer's caller runs onSuccess, and no sweep may run it.
      expect(hooks.onSuccess).not.toHaveBeenCalled();
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
    });

    it("keeps the key out when a racing write throws after another writer won and returned", async () => {
      const { store, hooks, records, reconciler, metrics } = setup();
      const key = await signed(store, [A]);
      // Writer 1 takes the key out, and its write hangs.
      let fail!: () => void;
      const failing = new Promise<void>((r) => (fail = r));
      const writer1 = records.finalWrite(key, async () => {
        await failing;
        throw new Error("store down");
      });
      // Writer 2 wins and returns first, so it ran the hooks and counted the fee.
      expect(
        await records.finish(
          key,
          { state: "success", ledger: 4_000, feeCharged: 41_000n },
          "settle",
        ),
      ).toMatchObject({ won: true });
      // Writer 1 throws only now: it can't have committed, since writer 2 moved the record from a
      // non-final state, so it must not put the key back for a sweep to run the hooks again.
      fail();
      await expect(writer1).rejects.toThrow("store down");
      expect(records.unconfirmed.has(key)).toBe(false);
      await reconciler.sweep();
      await reconciler.sweep();
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
    });

    it("keeps the key out when a racing write loses after another writer won and returned", async () => {
      const { store, hooks, records, reconciler, metrics } = setup();
      const key = await signed(store, [A]);
      // An earlier write threw without committing, so the key is listed.
      vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("store down"));
      await expect(
        records.finish(key, { state: "success", ledger: 4_000, feeCharged: 41_000n }, "settle"),
      ).rejects.toThrow("store down");
      expect(records.unconfirmed.has(key)).toBe(true);
      // Writer 1 takes the listed key out, and its compare-and-set from `signed` hangs.
      const transition = store.transition.bind(store);
      let lose!: () => void;
      const losing = new Promise<void>((r) => (lose = r));
      const writer1 = records.finalWrite(key, async () => {
        await losing;
        return transition(key, "signed", { state: "success", updatedAt: NOW });
      });
      // Writer 2 wins and returns first.
      expect(
        await records.finish(
          key,
          { state: "success", ledger: 4_000, feeCharged: 41_000n },
          "settle",
        ),
      ).toMatchObject({ won: true });
      // Writer 1 loses to writer 2's record, not to the earlier write: no key goes back.
      lose();
      expect(await writer1).toBeUndefined();
      expect(records.unconfirmed.has(key)).toBe(false);
      await reconciler.sweep();
      await reconciler.sweep();
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
    });

    it("runs the hooks once when a write that throws races a winning one on PostgreSQL, 200 times", async () => {
      let twice = 0;
      for (let run = 0; run < 200; run++) {
        await db.empty();
        const { store, hooks, records, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
        const key = await signed(store, [A]);
        // One of the two writes fails without committing, a moment later, as a dropped connection
        // does; the other goes to PostgreSQL. Whichever returns first, the hooks run once.
        const transition = store.transition.bind(store);
        vi.spyOn(store, "transition").mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, run % 4));
          throw new Error("store down");
        });
        const update = { state: "success" as const, ledger: 4_000, feeCharged: 41_000n };
        const results = await Promise.allSettled([
          records.finish(key, update, "settle"),
          records.finish(key, update, "resolved"),
        ]);
        vi.mocked(store.transition).mockImplementation(transition);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        await reconciler.sweep();
        await reconciler.sweep();
        if (hooks.onFinal.mock.calls.length !== 1) twice++;
        expect(metrics.value("fee_charged_stroops", { state: "success" }), `run ${run}`).toBe(
          41_000,
        );
      }
      expect(twice).toBe(0);
    }, 120_000);

    it("lists the key again for a later claim's write that throws, once the race is over", async () => {
      const { store, records } = setup();
      const key = await signed(store, [A]);
      expect(
        await records.finish(
          key,
          { state: "success", ledger: 4_000, feeCharged: 41_000n },
          "settle",
        ),
      ).toMatchObject({ won: true });
      // With no writer in flight, a win is forgotten: a reopened record's write (0073) that throws
      // may have committed, so it is listed as before.
      await expect(
        records.finalWrite(key, async () => {
          throw new Error("store down");
        }),
      ).rejects.toThrow("store down");
      expect(records.unconfirmed.has(key)).toBe(true);
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
    it.each(["success", "failed"] as const)(
      "reports a hash that landed as %s after its record ended expired (0088)",
      async (status) => {
        const { store, reconciler, lines, metrics } = setup({ [A]: missing(4_013) });
        const key = await signed(store, [A]);
        await reconciler.sweep();
        await reconciler.resolved({
          status,
          hash: A,
          channel: "GCHANNEL",
          ledger: 4_010,
          feeCharged: 41_000n,
          attempts: [{ hash: A, sent: "yes" }],
        });
        expect((await store.get(key))?.state).toBe("expired");
        const reports = lines
          .filter((line) => line.includes('"settlement_landed_after_expired"'))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ state: status, transaction: A, ledger: 4_010 });
        expect(metrics.value("settlement_landed_after_expired_total", { state: status })).toBe(1);
        // The fee was charged although the write is lost (0027); the expiry charged nothing.
        expect(metrics.value("fee_charged_stroops", { state: status })).toBe(41_000);
        expect(metrics.value("fee_charged_stroops", { state: "expired" })).toBe(0);
      },
    );

    it("doesn't report a pool's expired on a record a sweep already ended expired (0088)", async () => {
      const { store, reconciler, lines } = setup({ [A]: missing(4_013) });
      const key = await signed(store, [A]);
      await reconciler.sweep();
      await reconciler.resolved({
        status: "expired",
        hash: A,
        channel: "GCHANNEL",
        attempts: [{ hash: A, sent: "yes" }],
      });
      expect((await store.get(key))?.state).toBe("expired");
      expect(lines.some((line) => line.includes('"settlement_landed_after_expired"'))).toBe(false);
    });

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

    it("keeps the failure cause of a pending record that failed", async () => {
      const { store, reconciler } = setup();
      const key = await signed(store, [A]);
      await store.transition(key, "signed", { state: "pending", updatedAt: NOW });
      const failure = {
        opCode: "invokeHostFunctionTrapped",
        error: { type: "sceAuth", code: "x" },
      };
      await reconciler.resolved({
        status: "failed",
        hash: A,
        channel: "GCHANNEL",
        ledger: 4_001,
        feeCharged: 41_000n,
        errorCode: "txFeeBumpInnerFailed",
        failure,
        attempts: [{ hash: A, sent: "yes" }],
      });
      expect(await store.get(key)).toMatchObject({ state: "failed", failure });
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

  describe("fee_charged_stroops (0027)", () => {
    const pool = (feeCharged: bigint): SubmitResult => ({
      status: "success",
      hash: A,
      channel: "GCHANNEL",
      ledger: 4_001,
      feeCharged,
      attempts: [{ hash: A, sent: "yes" }],
    });

    it("adds a landed transaction's fee once, for a success and a failure alike", async () => {
      const { store, reconciler, metrics } = setup({
        [A]: landed("SUCCESS"),
        [B]: landed("FAILED"),
      });
      await signed(store, [A]);
      await signed(store, [B], undefined, "2");
      expect(await reconciler.sweep()).toMatchObject({ success: 1, failed: 1 });
      await reconciler.sweep();
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
      expect(metrics.value("fee_charged_stroops", { state: "failed" })).toBe(41_000);
    });

    it("counts a record the pool's event and a sweep both finish once, for the write that won", async () => {
      const { store, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
      const key = await signed(store, [A]);
      const list = store.listNonFinal.bind(store);
      store.listNonFinal = async (n) => {
        const listed = await list(n);
        // The pool's event finishes the record between the sweep's listing and its write.
        await reconciler.resolved(pool(40_000n));
        return listed;
      };
      expect(await reconciler.sweep()).toMatchObject({ success: 0, open: 1 });
      expect((await store.get(key))?.feeCharged).toBe(40_000n);
      // A late event for the same hash finds the record final too.
      await reconciler.resolved(pool(40_000n));
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(40_000);
    });

    it("adds nothing for an event after a sweep finished the record", async () => {
      const { store, reconciler, metrics } = setup({ [A]: landed("SUCCESS") });
      await signed(store, [A]);
      expect(await reconciler.sweep()).toMatchObject({ success: 1 });
      await reconciler.resolved(pool(40_000n));
      expect(metrics.value("fee_charged_stroops", { state: "success" })).toBe(41_000);
    });

    it("adds nothing for a record closed without a landing", async () => {
      const { store, reconciler, metrics, advance } = setup({ [A]: missing(4_013) });
      await claimed(store, "2");
      await signed(store, [A]);
      advance(BUDGET_MS + 5_001);
      expect(await reconciler.sweep()).toMatchObject({ rejected: 1, expired: 1 });
      expect(metrics.value("fee_charged_stroops", { state: "rejected" })).toBe(0);
      expect(metrics.value("fee_charged_stroops", { state: "expired" })).toBe(0);
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
      metrics: t.metrics,
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

  it("counts listed once per sweep, at the listing, even when the sweep then fails on its records (0027)", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signed(t.store, [A]);
    await signed(t.store, [B], undefined, "2");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.getTransaction.mockImplementation(async () => {
      await gate;
      throw new Error("rpc down");
    });
    const { schedule, sweep, metrics } = scheduled(t);
    const sweeps = (outcome: string) => metrics.value("settlement_sweeps_total", { outcome });
    schedule.start();
    await vi.waitFor(() => expect(t.getTransaction).toHaveBeenCalledTimes(2));
    // Before any record is checked: a long sweep doesn't read as one that stopped.
    expect(sweeps("listed")).toBe(1);
    release();
    await schedule.reconciled;
    await expect(sweep.mock.results[0]?.value).resolves.toMatchObject({ errors: 2 });
    expect(sweeps("listed")).toBe(1);
    expect(sweeps("failed")).toBe(0);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await sweep.mock.results.at(-1)?.value;
    expect(sweeps("listed")).toBe(2);
    schedule.close();
  });

  it("counts failed once for a sweep that can't list the records (0027)", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.store.listNonFinal = async () => {
      throw new Error("store down");
    };
    const { schedule, metrics } = scheduled(t);
    schedule.start();
    await schedule.reconciled;
    expect(metrics.value("settlement_sweeps_total", { outcome: "failed" })).toBe(1);
    expect(metrics.value("settlement_sweeps_total", { outcome: "listed" })).toBe(0);
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
    const t = setup({ [A]: missing(4_013, 0, NOW / 1000 + 1) });
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
