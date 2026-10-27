import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import type { SubmitOptions, SubmitResult } from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementStore } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import { createReconciler } from "../src/settlement/reconcile.js";
import { createRecords } from "../src/settlement/records.js";
import {
  SETTLE_REASONS,
  createSettler,
  type SettlerDeps,
  type Submitter,
} from "../src/settlement/settle.js";
import { PAYER_AUTH_REASON, payerNonce, type Check } from "../src/settlement/verify.js";
import { testDatabase } from "./database.js";

const db = testDatabase();
beforeEach(db.empty);

// `attemptsOf` reads a private WeakMap that only the real submitter fills; these tests put the
// attempts on the error instead. `settle-pool.test.ts` runs the real pool's.
vi.mock("@stellar-x402/signer-pool", async (original) => ({
  ...(await original<typeof import("@stellar-x402/signer-pool")>()),
  attemptsOf: (error: unknown) => (error as { attempts?: unknown[] })?.attempts ?? [],
}));

const network = STELLAR_NETWORKS.testnet;
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const CURRENT = 1_000;
const EXPIRATION = 1_012;
const HASH = "a".repeat(64);
/** The bounds the pool gives `onSigned` with each hash. */
const BOUNDS = { maxTime: 1_700_000_060, maxLedger: 1_000 };
const ACCEPTED_PAY_TO = Keypair.random().publicKey();

const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

function authEntry(address: string, nonce: string) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: EXPIRATION,
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
}

function transaction(auth = [authEntry(payer, "7")]) {
  return (
    new TransactionBuilder(new Account(payer, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: asset,
          function: "transfer",
          args: [
            nativeToScVal(payer, { type: "address" }),
            nativeToScVal(payTo, { type: "address" }),
            nativeToScVal(1000n, { type: "i128" }),
          ],
          auth,
        }),
      )
      // Fixed time bounds: the same arguments build the same transaction, so the same fingerprint.
      .setTimebounds(0, 2_000_000_000)
      .build()
  );
}

const payload = (auth?: xdr.SorobanAuthorizationEntry[]): PaymentPayload => ({
  x402Version: 2,
  // Differs from the requirements in amount, asset and payTo, so the tests see which one the
  // settler uses.
  accepted: {
    ...requirements,
    amount: "1",
    asset: StrKey.encodeContract(Buffer.alloc(32, 8)),
    payTo: ACCEPTED_PAY_TO,
  },
  payload: { transaction: transaction(auth).toXDR() },
});

/** A check that accepts any payload with one payer entry: the `/verify` checks have their own tests. */
const passing: Check = async (p) => {
  const tx = TransactionBuilder.fromXDR(
    (p.payload as { transaction: string }).transaction,
    Networks.TESTNET,
  ) as ReturnType<typeof transaction>;
  const nonce = payerNonce({ transaction: tx, payer });
  if (nonce === undefined) {
    return { response: { isValid: false, invalidReason: PAYER_AUTH_REASON, payer } };
  }
  return {
    response: { isValid: true, payer },
    verified: {
      transaction: tx,
      payer,
      nonce,
      expirationLedger: EXPIRATION,
      currentLedger: CURRENT,
    },
  };
};

type Behaviour = (opts: SubmitOptions) => Promise<SubmitResult>;

/** The pool's answer for a call it signed as `hash`. */
const result = (status: SubmitResult["status"] = "success", hash = HASH): SubmitResult => ({
  status,
  hash,
  channel: "GCHANNEL",
  ledger: status === "success" || status === "failed" ? CURRENT + 1 : undefined,
  feeCharged: 41_000n,
  attempts: [{ hash, sent: "yes" }],
});

/** Signs (stores the hash through `onSigned`), then answers with `status`. */
const landing =
  (status: SubmitResult["status"] = "success", hash = HASH): Behaviour =>
  async (opts) => {
    await opts.onSigned?.(hash, BOUNDS);
    return result(status, hash);
  };

function setup(behaviour: Behaviour = landing(), overrides: Partial<SettlerDeps> = {}) {
  const order: string[] = [];
  const store = db.stores().settlements;
  const submit = vi.fn<Submitter["submit"]>(async (_call, opts = {}) => {
    order.push("submit");
    return behaviour(opts);
  });
  const hooks = {
    beforeSubmit: vi.fn<SettlementHooks["beforeSubmit"]>(async () => {
      order.push("beforeSubmit");
      return { allow: true };
    }),
    onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
    onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
  };
  const lines: string[] = [];
  const metrics = memoryMetrics();
  const settle = createSettler({
    storeGraceMs: 20,
    network,
    check: passing,
    store,
    submitter: { submit },
    hooks,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
    maxFeeStroops: 250_000n,
    settleTimeoutMs: 2_000,
    budgetMs: 5_000,
    pollMs: 5,
    ...overrides,
  });
  return { settle, store, submit, hooks, order, lines, metrics };
}

const key = `${network}:${payer}:7` as const;
const alreadySettled = {
  success: false,
  errorReason: SETTLE_REASONS.alreadySettled,
  errorMessage: "this payment's success was already answered",
  payer,
  transaction: HASH,
  network,
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Refutation attempts on PR #57 at 3097c24.
// ---------------------------------------------------------------------------------------------

const landedTx = {
  status: rpc.Api.GetTransactionStatus.SUCCESS,
  ledger: 1001,
  resultXdr: { feeCharged: () => ({ toBigInt: () => 41_000n }) },
} as unknown as rpc.Api.GetTransactionResponse;

/** A settler and reconciler sharing one store and `records` (as buildSettlement wires them). */
function process1(
  behaviour: Behaviour,
  answer: rpc.Api.GetTransactionResponse,
  overrides: Partial<SettlerDeps> = {},
  store = db.stores().settlements,
) {
  const hooks = {
    onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
    onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
  };
  const logger = jsonLogger("error", () => {});
  const metrics = memoryMetrics();
  const records = createRecords({ network, store, hooks, logger, metrics });
  const { settle } = setup(behaviour, { store, records, ...overrides });
  const reconciler = createReconciler({
    network,
    store,
    rpc: { getTransaction: async () => answer },
    records,
    logger,
    metrics,
    budgetMs: overrides.budgetMs ?? 5_000,
  });
  return { store, hooks, records, settle, reconciler };
}

/** The success write fails once (store blip) and the read-back after it waits for `release`. */
function failSuccessWriteAndHoldReadBack(store: SettlementStore) {
  const transition = store.transition.bind(store);
  const get = store.get.bind(store);
  const state: { release?: () => void } = {};
  vi.spyOn(store, "transition").mockImplementation(async (k, from, update, version) => {
    if (update.state !== "success" || state.release) return transition(k, from, update, version);
    vi.spyOn(store, "get").mockImplementationOnce(async (gk) => {
      await new Promise<void>((resolve) => (state.release = resolve));
      return get(gk);
    });
    throw new Error("store down");
  });
  return state;
}

describe("REFUTE A: …_already_settled answered although no success was ever sent", () => {
  // Each test states the expected behaviour (AD-6: the success is answered once, to someone), so
  // it fails on 3097c24.

  it("A1 (lead): a client that left during the read-back retries; the retry must get the success", async () => {
    const p = process1(landing(), landedTx);
    const held = failSuccessWriteAndHoldReadBack(p.store);
    const left = new AbortController();
    const first = p.settle(payload(), requirements, left.signal);
    await vi.waitFor(() => expect(held.release).toBeDefined());
    // The store is back for new connections: a sweep stores the success.
    expect(await p.reconciler.sweep()).toMatchObject({ success: 1 });
    // The caller gave up on the first call and retries the same payment.
    left.abort();
    const retry = (await p.settle(payload(), requirements)).response;
    held.release!();
    await first; // its client is gone: this answer is never read
    // Observed on 3097c24: retry = …_already_settled, and only a SECOND retry gets success.
    expect(retry.success).toBe(true);
  });

  it("A2: no retry at all: the call's own budget answer must not be already_settled while its success is dropped", async () => {
    const p = process1(landing(), landedTx, { budgetMs: 300 });
    const held = failSuccessWriteAndHoldReadBack(p.store);
    const first = p.settle(payload(), requirements);
    await vi.waitFor(() => expect(held.release).toBeDefined());
    // A sweep stores the success while the read-back hangs (store recovering).
    expect(await p.reconciler.sweep()).toMatchObject({ success: 1 });
    // The budget runs out before the read-back returns: this is the ONLY answer of the call.
    const only = (await first).response;
    held.release!();
    await delay(20);
    // Observed on 3097c24: only = …_already_settled, and the record stays unmarked (nobody was
    // ever answered success; a later repeat is the first to get it).
    expect(only).not.toEqual(alreadySettled);
  });

  it("A3: upstream's one retry on settlement_pending (x402ResourceServer.settleWithPendingRetry) is told already_settled; nobody ever gets success", async () => {
    const p = process1(landing(), landedTx, { budgetMs: 300 });
    const held = failSuccessWriteAndHoldReadBack(p.store);
    const first = p.settle(payload(), requirements);
    await vi.waitFor(() => expect(held.release).toBeDefined());
    // The budget runs out while the read-back hangs; the record is still `signed`.
    const pending = (await first).response;
    expect(pending).toMatchObject({ errorReason: SETTLE_REASONS.pending, transaction: HASH });
    // Upstream retries exactly once, at once, with the same payload; a sweep lands it meanwhile.
    const retrying = p.settle(payload(), requirements);
    await delay(20);
    expect(await p.reconciler.sweep()).toMatchObject({ success: 1 });
    const retry = (await retrying).response;
    held.release!();
    await delay(20);
    // Upstream stops here (capped at one retry). Observed on 3097c24: …_already_settled.
    expect(retry.success).toBe(true);
  });
});

describe("REFUTE C: hooks run twice", () => {
  it("C2: one process: runLostHooks reads a final record whose writer in this process hasn't returned yet; both run onFinal", async () => {
    const p = process1(landing(), landedTx, { storeGraceMs: 500 });
    // A hashless claim from a call long past its budget.
    await p.store.claim({
      key,
      network,
      payer,
      nonce: "7",
      fingerprint: "f",
      paymentPayload: payload(),
      paymentRequirements: requirements,
      createdAt: Date.now() - 60_000,
    });
    // An earlier final write for it threw (store blip), so the key is unconfirmed.
    await p.records
      .finalWrite(key, async () => {
        throw new Error("store blip");
      })
      .catch(() => undefined);
    expect(p.records.unconfirmed.has(key)).toBe(true);
    // A writer in this process now ends it; its store answer comes back a little late.
    const transition = p.store.transition.bind(p.store);
    let returned!: () => void;
    const back = new Promise<void>((r) => (returned = r));
    vi.spyOn(p.store, "transition").mockImplementationOnce(async (...args) => {
      const moved = await transition(...args); // committed
      await back; // the reply is on its way
      return moved;
    });
    const writer = p.records.finish(
      key,
      { state: "rejected", errorReason: SETTLE_REASONS.timeout },
      "settle",
    );
    await delay(5);
    // The 10 s sweep starts now: runLostHooks finds the record final.
    await p.reconciler.sweep();
    returned();
    await writer;
    await delay(5);
    expect(p.hooks.onFinal).toHaveBeenCalledTimes(1);
  });

  it("C3: one process, no commit uncertainty: a read that fails inside a final write on an already-final record makes the next sweep run onFinal/onSuccess again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = process1(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      await gate; // the pool is still confirming
      return result("success");
    }, landedTx);
    const first = p.settle(payload(), requirements);
    await vi.waitFor(async () => expect((await p.store.get(key))?.hashes).toEqual([HASH]));
    // The 10 s sweep sees it landed first: hooks run once, here.
    expect(await p.reconciler.sweep()).toMatchObject({ success: 1 });
    expect(p.hooks.onFinal).toHaveBeenCalledTimes(1);
    expect(p.hooks.onSuccess).toHaveBeenCalledTimes(1);
    // The pool's answer arrives during a store blip: the settler's read inside `finish` fails.
    vi.spyOn(p.store, "get").mockRejectedValueOnce(new Error("connection terminated"));
    release();
    await first;
    // Nothing was written by that failed call, yet the key is now "unconfirmed" (true on 3097c24).
    const unconfirmed = p.records.unconfirmed.has(key);
    await p.reconciler.sweep();
    await delay(5);
    expect({
      unconfirmed,
      onFinal: p.hooks.onFinal.mock.calls.length,
      onSuccess: p.hooks.onSuccess.mock.calls.length,
    }).toEqual({ unconfirmed: false, onFinal: 1, onSuccess: 1 });
  });
});
