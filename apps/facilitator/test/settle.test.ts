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
import {
  FallbackRpc,
  FeeLimitError,
  LedgerBoundError,
  NoChannelsError,
  QueueTimeoutError,
  ShutdownError,
  RpcTimeoutError,
  RpcUnavailableError,
  SignedHookError,
  SimulationCheckError,
  SimulationError,
  SourceAccountAuthError,
  type SorobanRpc,
  type SubmitOptions,
  type SubmitResult,
} from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementStore } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import { createReconciler } from "../src/settlement/reconcile.js";
import { createRecords } from "../src/settlement/records.js";
import {
  SETTLE_REASONS,
  createSettler,
  expectTransfer,
  fingerprintOf,
  type SettlerDeps,
  type Submitter,
} from "../src/settlement/settle.js";
import {
  PAYER_AUTH_REASON,
  createChecker,
  payerNonce,
  type Check,
} from "../src/settlement/verify.js";
import { testDatabase } from "./database.js";

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

/** A diagnostic contract event from `contract`. */
const event = (
  topics: xdr.ScVal[],
  data: xdr.ScVal = nativeToScVal(1000n, { type: "i128" }),
  contract = asset,
) =>
  new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(
        contract,
      ) as unknown as xdr.ContractEvent["contractId"] extends () => infer T ? T : never,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
const transferEvent = (from = payer, to = payTo, data?: xdr.ScVal, contract?: string) =>
  event(
    [
      xdr.ScVal.scvSymbol("transfer"),
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
    ],
    data,
    contract,
  );
const sim = (...events: xdr.DiagnosticEvent[]) =>
  ({ events }) as unknown as rpc.Api.SimulateTransactionSuccessResponse;

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

const db = testDatabase();
beforeEach(db.empty);

/**
 * A `/settle` budget for the cases where it runs out: the claim and the hash's write, each a few
 * database round trips, fit in it on a loaded machine.
 */
const BUDGET_MS = 100;
/** A database call in a loaded test run can take tens of ms; less would read it as a failing store. */
const STORE_GRACE_MS = 200;

/** Resolves once no query of the test database's pool runs or waits for a connection. */
async function storeIdle() {
  do {
    await new Promise((resolve) => setImmediate(resolve));
  } while (db.pool.totalCount > db.pool.idleCount || db.pool.waitingCount > 0);
}

/**
 * Moves the fake clock `ms` on, a millisecond at a time, each once the store has answered: a slow
 * database then never runs a budget out before the step a test names.
 */
async function elapse(ms: number) {
  for (let tick = 0; tick < ms; tick++) {
    await storeIdle();
    await vi.advanceTimersByTimeAsync(1);
  }
  await storeIdle();
}

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
    storeGraceMs: STORE_GRACE_MS,
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
    latestLedger: async () => CURRENT,
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

describe("createSettler", () => {
  it("claims, runs beforeSubmit, submits the client's call bounded by its auth, and answers success", async () => {
    const { settle, store, submit, hooks, order } = setup();
    const p = payload();
    const settled = await settle(p, requirements);

    expect(settled.response).toEqual({ success: true, transaction: HASH, network, payer });
    expect(order).toEqual(["beforeSubmit", "submit"]);
    expect(hooks.beforeSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ key, payer, payTo, asset, amount: 1000n, maxFeeStroops: 250_000n }),
    );

    const [call, opts] = submit.mock.calls[0]!;
    const op = transaction().operations[0] as Operation.InvokeHostFunction;
    expect(call.func.toXDR("base64")).toBe(op.func.toXDR("base64"));
    expect(call.auth.map((entry) => entry.toXDR("base64"))).toEqual(
      op.auth!.map((entry) => entry.toXDR("base64")),
    );
    expect(opts?.maxLedger).toBe(EXPIRATION);
    expect(opts?.deadline).toBeGreaterThan(Date.now());
    // The balance-change check is built from the requirements, not from `accepted`.
    expect(() => opts?.checkSimulation?.(sim(transferEvent()))).not.toThrow();
    expect(() => opts?.checkSimulation?.(sim())).toThrow();
    expect(() => opts?.checkSimulation?.(sim(transferEvent(payer, p.accepted.payTo)))).toThrow();

    const record = await store.get(key);
    expect(record).toMatchObject({ state: "success", hashes: [HASH], ledger: CURRENT + 1 });
    expect(settled.record).toEqual(record);
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
    // `onSuccess` waits for the route to send the response.
    expect(hooks.onSuccess).not.toHaveBeenCalled();
    settled.afterResponse!();
    expect(hooks.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ key, state: "success", hashes: [HASH] }),
      "settle",
    );
  });

  it("submits once for concurrent calls with one settlement key, and answers success once, to whichever marks it", async () => {
    // A repeat may mark the success before the submitting call does (see `respond`).
    const { settle, submit, hooks, metrics } = setup(async (opts) => {
      await delay(20);
      return landing()(opts);
    });
    const p = payload();
    const answers = await Promise.all(Array.from({ length: 5 }, () => settle(p, requirements)));

    expect(submit).toHaveBeenCalledTimes(1);
    const successes = answers.filter(({ response }) => response.success);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.record?.state).toBe("success");
    for (const answer of answers.filter(({ response }) => !response.success)) {
      expect(answer.response).toEqual(alreadySettled);
      expect(answer.record).toBeUndefined();
    }
    // The four repeats, whichever call marked the success.
    expect(answers.filter((answer) => answer.replay)).toHaveLength(4);
    expect(answers.filter((answer) => answer.afterResponse)).toHaveLength(1);
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
    expect(metrics.value("settlement_already_settled_total")).toBe(4);
  });

  it("answers a repeat after the success with already_settled and the hash, without submitting", async () => {
    const { settle, submit } = setup();
    const first = await settle(payload(), requirements);
    expect(first.response.success).toBe(true);
    const repeat = await settle(payload(), requirements);
    expect(repeat.response).toEqual(alreadySettled);
    expect(repeat.record).toBeUndefined();
    expect(repeat.afterResponse).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("keeps the success for the client's retry when the call that settled lost its client", async () => {
    const { settle } = setup(async (opts) => {
      await delay(20);
      return landing()(opts);
    });
    const gone = new AbortController();
    const first = settle(payload(), requirements, gone.signal);
    gone.abort();
    expect((await first).response.success).toBe(true);
    expect((await settle(payload(), requirements)).response).toMatchObject({ success: true });
    expect((await settle(payload(), requirements)).response).toEqual(alreadySettled);
  });

  it("answers a known settlement from its record without rerunning the checks, which fail once it landed", async () => {
    // On chain, a landed payment's nonce is used, so upstream's simulation of it fails.
    let landed = false;
    const check = vi.fn<Check>(async (p, r) =>
      landed
        ? {
            response: {
              isValid: false,
              invalidReason: "invalid_exact_stellar_payload_simulation_failed",
            },
          }
        : passing(p, r),
    );
    const { settle } = setup(landing(), { check });
    await settle(payload(), requirements);
    landed = true;

    expect((await settle(payload(), requirements)).response).toEqual(alreadySettled);
    const other = { ...requirements, extra: { merchant: "another" } };
    expect((await settle({ ...payload(), accepted: other }, other)).response).toMatchObject({
      errorReason: SETTLE_REASONS.nonceUsed,
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("waits within the settle timeout for a pending record, then answers its outcome", async () => {
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const { settle, store, submit } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      await landed;
      return result();
    });
    const first = settle(payload(), requirements);
    await vi.waitFor(async () => expect((await store.get(key))?.state).toBe("signed"));
    const repeat = settle(payload(), requirements);
    setTimeout(land, 30);
    const answers = [(await repeat).response, (await first).response];
    expect(answers.filter((response) => response.success)).toHaveLength(1);
    expect(answers).toContainEqual(alreadySettled);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("gives the success to the retry after a settlement_pending answer: pending doesn't use it up", async () => {
    let land!: () => void;
    const { settle, store } = setup(
      async (opts) => {
        await opts.onSigned?.(HASH, BOUNDS);
        await new Promise<void>((resolve) => (land = resolve));
        return result();
      },
      { budgetMs: BUDGET_MS, settleTimeoutMs: BUDGET_MS },
    );
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.pending,
    });
    land();
    await vi.waitFor(async () => expect((await store.get(key))?.state).toBe("success"));
    const retry = await settle(payload(), requirements);
    expect(retry.response).toEqual({ success: true, transaction: HASH, network, payer });
    expect(retry.record?.state).toBe("success");
    expect((await settle(payload(), requirements)).response).toEqual(alreadySettled);
  });

  it("shares one store read per poll among the repeats of a key, and stops a repeat whose client left", async () => {
    const { settle, store } = setup(
      async (opts) => {
        await opts.onSigned?.(HASH, BOUNDS);
        return new Promise(() => {});
      },
      { settleTimeoutMs: 100, budgetMs: 10_000, pollMs: 10 },
    );
    void settle(payload(), requirements);
    await vi.waitFor(async () => expect((await store.get(key))?.state).toBe("signed"));
    const get = vi.spyOn(store, "get");
    const repeats = Array.from({ length: 50 }, () => settle(payload(), requirements));
    await Promise.all(repeats);
    // 50 initial lookups, then one shared read per 10 ms poll. Unshared, each repeat would read
    // once per poll: about 50 more per 10 ms, some 500 over the 100 ms wait. The bound leaves a
    // loaded runner room, as PostgreSQL spreads the initial lookups and so the polling window.
    expect(get.mock.calls.length).toBeLessThan(50 + 100);

    // A repeat whose client left stops long before its settle timeout.
    const patient = setup(landing(), { settleTimeoutMs: 1_000, budgetMs: 10_000, pollMs: 10 });
    const gone = new AbortController();
    const started = Date.now();
    const left = patient.settle(payload(), requirements, gone.signal);
    setTimeout(() => gone.abort(), 15);
    await left;
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("answers settlement_pending to a repeat once the settle timeout runs out", async () => {
    const { settle } = setup(
      async (opts) => {
        await opts.onSigned?.(HASH, BOUNDS);
        return new Promise(() => {});
      },
      { settleTimeoutMs: 30, budgetMs: BUDGET_MS },
    );
    expect((await settle(payload(), requirements)).response).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH,
    });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: "settlement_pending",
      transaction: HASH,
    });
  });

  it("refuses a repeat with different requirements, never with the outcome but with the hash", async () => {
    const { settle, submit, metrics } = setup();
    await settle(payload(), requirements);
    // The same payload: only the requirements differ, so they must be in the fingerprint.
    const other = { ...requirements, extra: { merchant: "another" } };
    const answer = await settle(payload(), other);
    expect(answer.response).toEqual({
      success: false,
      errorReason: SETTLE_REASONS.nonceUsed,
      errorMessage: "this payer's nonce was already used for a different payment",
      payer,
      // So a payment that landed can be reconciled on chain.
      transaction: HASH,
      network,
    });
    expect(answer.record).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(metrics.value("settlement_nonce_reuse_total")).toBe(1);
  });

  it.each([
    ["no auth entry for the payer", [authEntry(Keypair.random().publicKey(), "1")]],
    ["two auth entries for the payer", [authEntry(payer, "1"), authEntry(payer, "2")]],
  ])("answers the checks' rejection of a payload with %s, without claiming", async (_, auth) => {
    const { settle, store, submit } = setup();
    const answer = await settle(payload(auth), requirements);
    expect(answer.response).toMatchObject({
      success: false,
      errorReason: SETTLE_REASONS.payerAuth,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(await store.listNonFinal(network)).toEqual([]);
  });

  it("answers a failed check with its reason, without claiming", async () => {
    const check: Check = async () => ({
      response: {
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_wrong_amount",
        payer,
      },
    });
    const { settle, submit } = setup(landing(), { check });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_wrong_amount",
      payer,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("answers settlement_pending with the hash when the pool reports pending, and stays open", async () => {
    const { settle, store, hooks } = setup(landing("pending"));
    const answer = await settle(payload(), requirements);
    expect(answer.response).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH,
      network,
      payer,
    });
    expect((await store.get(key))?.state).toBe("pending");
    expect(hooks.onFinal).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "settle_exact_stellar_transaction_failed"],
    ["rejected", "settle_exact_stellar_transaction_submission_failed"],
    ["expired", "settle_exact_stellar_transaction_expired"],
  ] as const)("records a %s result as final with a fixed reason", async (status, reason) => {
    const { settle, store, hooks } = setup(landing(status));
    expect((await settle(payload(), requirements)).response).toEqual({
      success: false,
      errorReason: reason,
      payer,
      transaction: HASH,
      network,
    });
    expect(await store.get(key)).toMatchObject({ state: status, errorReason: reason });
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new SimulationError("x"), "settle_exact_stellar_simulation_failed"],
    [new SimulationCheckError("x"), "settle_exact_stellar_unexpected_balance_changes"],
    [new FeeLimitError("x"), "settle_exact_stellar_fee_exceeds_maximum"],
    [new LedgerBoundError("x"), "settle_exact_stellar_signature_expiration_too_soon"],
    [new SignedHookError("x"), "settle_exact_stellar_record_write_failed"],
    [new QueueTimeoutError("x"), "settle_exact_stellar_no_channel_in_time"],
    [new NoChannelsError("x"), "settle_exact_stellar_no_channels"],
    [new ShutdownError("x"), "settle_exact_stellar_shutting_down"],
    [new RpcTimeoutError("x"), "settle_exact_stellar_rpc_unavailable"],
    [new RpcUnavailableError("x"), "settle_exact_stellar_rpc_unavailable"],
    [new SourceAccountAuthError("x"), "invalid_exact_stellar_payload_unsupported_credential_type"],
    [new Error("rpc down"), "unexpected_settle_error"],
  ])("maps a thrown %s to a fixed reason and ends the record", async (error, reason) => {
    const { settle, store, hooks, metrics } = setup(async () => {
      throw error;
    });
    // Nothing was sent, so the auth entry can still land: repeat it, don't sign again (0073).
    // Written out, not read from `UNSENT_REASONS`, so a reason dropped from it fails here.
    const unsent = [
      "settle_exact_stellar_no_channel_in_time",
      "settle_exact_stellar_no_channels",
      "settle_exact_stellar_shutting_down",
      "settle_exact_stellar_rpc_unavailable",
    ].includes(reason);
    expect((await settle(payload(), requirements)).response).toEqual({
      success: false,
      errorReason: reason,
      payer,
      transaction: "",
      network,
      ...(unsent && {
        errorMessage:
          `nothing was sent: repeat the same payment while the latest ledger is at most ` +
          `${EXPIRATION - 2}; once the network is past ledger ${EXPIRATION}, sign a new payment instead`,
        extra: { retryable: true, expirationLedger: EXPIRATION },
      }),
    });
    expect(await store.get(key)).toMatchObject({ state: "rejected", errorReason: reason });
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
    expect(metrics.value("settlement_submit_failures_total")).toBe(
      reason === SETTLE_REASONS.unexpected ? 1 : 0,
    );
  });

  it("drains a submission that runs on after its budget answer, with its record write (0025)", async () => {
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const { settle, store } = setup(
      async (opts) => {
        await opts.onSigned?.(HASH, BOUNDS);
        await landed;
        return result("success");
      },
      { budgetMs: 50 },
    );
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.pending,
    });
    let drained = false;
    const draining = settle.drain().then(() => (drained = true));
    await delay(20);
    expect(drained).toBe(false);
    land();
    await draining;
    expect(await store.get(key)).toMatchObject({ state: "success" });
  });

  it("warns and counts a fee refusal by /settle's own re-check, also a drift from /verify", async () => {
    const reason = "invalid_exact_stellar_payload_fee_exceeds_maximum";
    const check: Check = async () => ({
      response: { isValid: false, invalidReason: reason, payer },
    });
    const { settle, lines, metrics } = setup(landing(), { check });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: reason,
    });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "settlement_refused_after_verify",
        errorReason: reason,
        stage: "check",
      }),
    );
    expect(metrics.value("settlement_refused_after_verify_total", { reason, stage: "check" })).toBe(
      1,
    );
  });

  it("warns and counts a fee or ledger refusal, which means the pool disagreed with /verify", async () => {
    for (const [error, reason] of [
      [new FeeLimitError("x"), "settle_exact_stellar_fee_exceeds_maximum"],
      [new LedgerBoundError("x"), "settle_exact_stellar_signature_expiration_too_soon"],
    ] as const) {
      // Each case settles the same payment, so each starts on empty stores.
      await db.empty();
      const { settle, lines, metrics } = setup(async () => {
        throw error;
      });
      await settle(payload(), requirements);
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          level: "warn",
          event: "settlement_refused_after_verify",
          errorReason: reason,
        }),
      );
      expect(
        metrics.value("settlement_refused_after_verify_total", { reason, stage: "pool" }),
      ).toBe(1);
    }
    // Other refusals are not a drift between the two.
    await db.empty();
    const { settle, lines } = setup(async () => {
      throw new SimulationError("x");
    });
    await settle(payload(), requirements);
    expect(lines.join("")).not.toContain("settlement_refused_after_verify");
  });

  it("passes the payer on only as a string, through the real /verify checks", async () => {
    // Upstream reads `payer` from `from` before any signature check; the client picks its type.
    const check = createChecker({
      network,
      upstream: {
        verify: async () => ({
          isValid: false,
          invalidReason: "invalid_exact_stellar_payload_wrong_recipient",
          payer: 5 as unknown as string,
        }),
      },
      facilitator: Keypair.random().publicKey(),
      channels: [Keypair.random().publicKey()],
      minValidityLedgers: 2,
      maxValidityLedgers: 66,
      latestLedger: async () => CURRENT,
    });
    const { settle, submit } = setup(landing(), { check });
    const { response } = await settle(payload(), requirements);
    expect(response).toEqual({
      success: false,
      errorReason: "invalid_exact_stellar_payload_wrong_recipient",
      transaction: "",
      network,
    });
    // As the route sends it: `payer` is left out, not a number.
    expect(JSON.parse(JSON.stringify(response))).not.toHaveProperty("payer");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps the record open and answers pending when a thrown send may have reached the network", async () => {
    const { settle, store, hooks, metrics } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      throw Object.assign(new SignedHookError("x"), {
        attempts: [{ hash: HASH, sent: "unknown" }],
      });
    });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: "settlement_pending",
      transaction: HASH,
    });
    expect((await store.get(key))?.state).toBe("pending");
    expect(hooks.onFinal).not.toHaveBeenCalled();
    expect(metrics.value("settlement_uncertain_total")).toBe(1);
  });

  it("keeps the record open after an unexpected error that follows a send the network answered", async () => {
    // `sent: "yes"` may be an accepted send: nothing says this one won't land.
    const { settle, store, hooks } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      throw Object.assign(new Error("bug after the send"), {
        attempts: [{ hash: HASH, sent: "yes" }],
      });
    });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.pending,
      transaction: HASH,
    });
    expect((await store.get(key))?.state).toBe("pending");
    expect(hooks.onFinal).not.toHaveBeenCalled();
  });

  it("ends the record on a classified error after a refused send: the pool knows it won't land", async () => {
    // A txBadSeq refusal, then the rebuild's simulation fails.
    const { settle, store } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      throw Object.assign(new SimulationError("rebuild failed"), {
        attempts: [{ hash: HASH, sent: "yes" }],
      });
    });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.simulation,
    });
    expect((await store.get(key))?.state).toBe("rejected");
  });

  it("sends nothing once the lease is lost after the request came in (0025 decision 22)", async () => {
    let held = true;
    let signed: unknown = "not called";
    const { settle, store } = setup(
      async (opts) => {
        // E.g. a DB failover during the wait for a channel: the next renewal fails.
        held = false;
        // As the pool does: a hook that throws means this envelope is not sent.
        signed = await Promise.resolve(opts.onSigned!(HASH, BOUNDS)).then(
          () => "sent",
          (error: unknown) => error,
        );
        throw Object.assign(new SignedHookError("x"), { attempts: [{ hash: HASH, sent: "no" }] });
      },
      { held: () => held },
    );
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.recordWrite,
    });
    expect(signed).toBeInstanceOf(Error);
    expect((signed as Error).message).toBe("the channel lease was lost");
    expect(await store.get(key)).toMatchObject({ state: "rejected", hashes: [HASH] });
  });

  it("answers pending with the hash of a send that may have reached the network, even when the store fails", async () => {
    const { settle, store } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      throw Object.assign(new Error("connection reset"), {
        attempts: [{ hash: HASH, sent: "unknown" }],
      });
    });
    vi.spyOn(store, "transition").mockRejectedValue(new Error("store down"));
    expect((await settle(payload(), requirements)).response).toEqual({
      success: false,
      errorReason: SETTLE_REASONS.pending,
      payer,
      transaction: HASH,
      network,
    });
  });

  it("ends the record with the hook's reason when beforeSubmit refuses, without onFinal", async () => {
    const { settle, store, submit, hooks } = setup();
    hooks.beforeSubmit.mockResolvedValueOnce({
      allow: false,
      errorReason: "spend_budget_exceeded",
    });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      success: false,
      errorReason: "spend_budget_exceeded",
    });
    expect(submit).not.toHaveBeenCalled();
    expect(await store.get(key)).toMatchObject({
      state: "rejected",
      errorReason: "spend_budget_exceeded",
    });
    expect(hooks.onFinal).not.toHaveBeenCalled();
  });

  it("answers a beforeSubmit refusal even when the store can't record it", async () => {
    const { settle, store, hooks, lines } = setup();
    hooks.beforeSubmit.mockResolvedValueOnce({ allow: false, errorReason: "over_budget" });
    vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("store down"));
    expect((await settle(payload(), requirements)).response).toMatchObject({
      success: false,
      errorReason: "over_budget",
    });
    expect(lines.join("")).toContain("settlement_record_failed");
  });

  it("answers with the pool's result when the store fails to record it", async () => {
    const { settle, store } = setup();
    vi.spyOn(store, "transition").mockRejectedValue(new Error("store down"));
    // The repeat lookup and `advance`'s read work; reading the record back after the failed
    // write doesn't.
    const get = store.get.bind(store);
    vi.spyOn(store, "get")
      .mockImplementationOnce(get)
      .mockImplementationOnce(get)
      .mockRejectedValue(new Error("store down"));
    const settled = await settle(payload(), requirements);
    expect(settled.response).toEqual({ success: true, transaction: HASH, network, payer });
    // The record as it would have been stored, for the EXTENSION-RESPONSES header (0031).
    expect(settled.record).toMatchObject({ key, state: "success", hashes: [HASH] });
    expect(settled.afterResponse).toBeUndefined();
  });

  it("treats a beforeSubmit that throws as a refusal, and logs the key", async () => {
    const { settle, submit, hooks, metrics, lines } = setup();
    hooks.beforeSubmit.mockRejectedValueOnce(new Error("store down"));
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.refused,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(metrics.value("settlement_hook_failures_total", { hook: "beforeSubmit" })).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "settlement_hook_failed", network, settlementKey: key }),
    );
  });

  it("keeps a success answer when onFinal or onSuccess fails, and counts the failure", async () => {
    const { settle, hooks, metrics, lines } = setup();
    hooks.onFinal.mockRejectedValueOnce(new Error("spend store down"));
    hooks.onSuccess.mockImplementationOnce(() => {
      throw new Error("sync throw");
    });
    const answer = await settle(payload(), requirements);
    expect(answer.response.success).toBe(true);
    answer.afterResponse!();
    await vi.waitFor(() =>
      expect(metrics.value("settlement_hook_failures_total", { hook: "onFinal" })).toBe(1),
    );
    expect(metrics.value("settlement_hook_failures_total", { hook: "onSuccess" })).toBe(1);
    expect(lines.join("")).toContain("settlement_hook_failed");
  });

  it("answers rpc_unavailable when every RPC endpoint refuses the connection", async () => {
    const refusing = {
      getLedgerEntries: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
          code: "ECONNREFUSED",
        });
      },
    } as unknown as SorobanRpc;
    const rpc = new FallbackRpc([
      { name: "a", rpc: refusing },
      { name: "b", rpc: refusing },
    ]);
    // What the pool's sequence read passes on from `FallbackRpc`.
    const error = await rpc.getLedgerEntries().catch((e: unknown) => e);
    const { settle } = setup(async () => {
      throw error;
    });
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.rpcUnavailable,
    });
  });

  it("counts every answer by its outcome", async () => {
    const { settle, metrics } = setup();
    await settle(payload(), requirements);
    await settle(payload(), requirements);
    expect(metrics.value("settlement_outcomes_total", { reason: "success", replay: "false" })).toBe(
      1,
    );
    expect(
      metrics.value("settlement_outcomes_total", {
        reason: SETTLE_REASONS.alreadySettled,
        replay: "true",
      }),
    ).toBe(1);
  });

  describe("when the store can't mark a success answered (ADR 0006)", () => {
    it("answers the success: the payment landed", async () => {
      const { settle, store, lines } = setup();
      vi.spyOn(store, "markSuccessAnswered").mockRejectedValue(new Error("store down"));
      const settled = await settle(payload(), requirements);
      expect(settled.response).toEqual({ success: true, transaction: HASH, network, payer });
      expect(settled.record).toMatchObject({ key, state: "success" });
      expect(lines.join("")).toContain("settlement_record_failed");
    });

    it("answers it once in this process, to concurrent and later repeats alike", async () => {
      const { settle, store } = setup();
      // The mark hangs: each caller waits at most the store's grace.
      vi.spyOn(store, "markSuccessAnswered").mockImplementation(() => new Promise(() => {}));
      const first = await settle(payload(), requirements);
      expect(first.response.success).toBe(true);
      const repeats = await Promise.all([1, 2, 3].map(() => settle(payload(), requirements)));
      expect(repeats.map(({ response }) => response)).toEqual([
        alreadySettled,
        alreadySettled,
        alreadySettled,
      ]);
    });

    it("answers concurrent callers once while the mark is in flight", async () => {
      const { settle, store } = setup(async (opts) => {
        await delay(10);
        return landing()(opts);
      });
      vi.spyOn(store, "markSuccessAnswered").mockImplementation(() => new Promise(() => {}));
      const answers = await Promise.all([1, 2, 3].map(() => settle(payload(), requirements)));
      expect(answers.map(({ response }) => response.success).sort()).toEqual([false, false, true]);
    });

    it("answers a success from the pool's result once too, when the store failed to record it", async () => {
      const { settle, store } = setup();
      vi.spyOn(store, "transition").mockRejectedValue(new Error("store down"));
      expect((await settle(payload(), requirements)).response.success).toBe(true);
      // The record stays `signed` until 0019; say it turned `success` anyway.
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (k) => {
        const record = await get(k);
        return record && { ...record, state: "success" };
      });
      vi.spyOn(store, "markSuccessAnswered").mockResolvedValue(true);
      expect((await settle(payload(), requirements)).response).toEqual(alreadySettled);
    });

    it("leaves a success from the pool's result to a repeat when the budget answer replaced it", async () => {
      let land!: () => void;
      const { settle, store } = setup(
        async (opts) => {
          await opts.onSigned?.(HASH, BOUNDS);
          await new Promise<void>((resolve) => (land = resolve));
          return result();
        },
        { budgetMs: BUDGET_MS },
      );
      const transition = vi.spyOn(store, "transition");
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
        transaction: HASH,
      });
      // The success lands after the budget answer, and the store fails to record it.
      transition.mockRejectedValue(new Error("store down"));
      land();
      await vi.waitFor(() =>
        expect(transition).toHaveBeenCalledWith(
          key,
          "signed",
          expect.objectContaining({ state: "success" }),
          undefined,
          0,
        ),
      );
      // The record turns `success` later (0019, or a write whose client timed out).
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (k) => {
        const record = await get(k);
        return record && { ...record, state: "success" };
      });
      vi.spyOn(store, "markSuccessAnswered").mockResolvedValue(true);
      expect((await settle(payload(), requirements)).response).toEqual({
        success: true,
        transaction: HASH,
        network,
        payer,
      });
    });
  });

  it("answers pending with the hash of an uncertain send when the store fails, its reads too", async () => {
    const { settle, store } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      throw Object.assign(new Error("connection reset"), {
        attempts: [{ hash: HASH, sent: "unknown" }],
      });
    });
    // The known-key lookup works; every read after the send doesn't.
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(get).mockRejectedValue(new Error("store down"));
    expect((await settle(payload(), requirements)).response).toEqual({
      success: false,
      errorReason: SETTLE_REASONS.pending,
      payer,
      transaction: HASH,
      network,
    });
  });

  it.each([
    ["failed", SETTLE_REASONS.failed],
    ["pending", SETTLE_REASONS.pending],
  ] as const)(
    "answers a %s result with its hash when the store fails to record it",
    async (status, errorReason) => {
      const { settle, store } = setup(landing(status));
      vi.spyOn(store, "transition").mockRejectedValue(new Error("store down"));
      const settled = await settle(payload(), requirements);
      expect(settled.response).toEqual({
        success: false,
        errorReason,
        payer,
        transaction: HASH,
        network,
      });
      expect(settled.record).toBeUndefined();
    },
  );

  describe("a repeat while the store fails", () => {
    /** A first call that ends `pending` with the hash, then the store as `fail` sets it. */
    async function pendingThen(fail: (store: SettlementStore) => void) {
      const s = setup(landing("pending"), { settleTimeoutMs: 30, storeGraceMs: 20 });
      await s.settle(payload(), requirements);
      const get = s.store.get.bind(s.store);
      const spy = vi.spyOn(s.store, "get").mockImplementationOnce(get);
      fail(s.store);
      return { ...s, spy };
    }

    it("keeps the last record when a poll's read fails, and logs it", async () => {
      const { settle, lines } = await pendingThen((store) =>
        vi.mocked(store.get).mockRejectedValue(new Error("store down")),
      );
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
        transaction: HASH,
      });
      expect(lines.join("")).toContain("settlement_record_failed");
    });

    it("answers within the settle timeout and the grace when a poll's read hangs", async () => {
      const { settle } = await pendingThen((store) =>
        vi.mocked(store.get).mockImplementation(() => new Promise(() => {})),
      );
      const answer = await Promise.race([
        settle(payload(), requirements).then(({ response }) => response),
        delay(1_000).then(() => "hung"),
      ]);
      expect(answer).toMatchObject({ errorReason: SETTLE_REASONS.pending, transaction: HASH });
    });

    it("never says sign a new payment for an unsigned record it couldn't end", async () => {
      // The refusal couldn't be stored, so the record stays `claimed` with no hash.
      const s = setup(landing(), { budgetMs: BUDGET_MS });
      s.hooks.beforeSubmit.mockResolvedValueOnce({ allow: false, errorReason: "over_budget" });
      vi.spyOn(s.store, "transition").mockRejectedValue(new Error("store down"));
      await s.settle(payload(), requirements);
      await delay(BUDGET_MS + 10);
      // The repeat can't end it either: the record may still be signed elsewhere.
      expect((await s.settle(payload(), requirements)).response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.pending,
        transaction: "",
      });
    });
  });

  describe("settle budget (ADR 0011)", () => {
    // The budget and the store's grace run on a fake clock, which `elapse` moves.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });
    // A test's late writes end before the next test empties the tables.
    afterEach(async () => {
      await storeIdle();
      vi.useRealTimers();
    });

    it("answers settlement_pending with the hash once the budget runs out after signing, and catalogs a late success", async () => {
      let land!: () => void;
      const { settle, store, hooks } = setup(
        async (opts) => {
          await opts.onSigned?.(HASH, BOUNDS);
          await new Promise<void>((resolve) => (land = resolve));
          return result();
        },
        { budgetMs: BUDGET_MS },
      );
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      expect((await settled).response).toMatchObject({
        errorReason: "settlement_pending",
        transaction: HASH,
      });
      land();
      await storeIdle();
      expect((await store.get(key))?.state).toBe("success");
      // One origin for the one transition: both hooks say `resolved`.
      expect(hooks.onSuccess).toHaveBeenCalledWith(expect.anything(), "resolved");
      expect(hooks.onFinal).toHaveBeenCalledExactlyOnceWith(expect.anything(), "resolved");
    });

    it("answers a success that lands as the budget runs out with the record, for the header", async () => {
      const { settle, store } = setup(
        async (opts) => {
          await opts.onSigned?.(HASH, BOUNDS);
          return new Promise(() => {});
        },
        { budgetMs: BUDGET_MS },
      );
      // The pool's success is recorded just as the budget's compare-and-set runs.
      const transition = store.transition.bind(store);
      vi.spyOn(store, "transition").mockImplementation(async (k, expected, update) => {
        if (expected === "claimed" && update.state === "rejected") {
          await transition(k, "signed", { state: "success", updatedAt: Date.now() });
        }
        return transition(k, expected, update);
      });
      const settling = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      const settled = await settling;
      expect(settled.response).toMatchObject({ success: true, transaction: HASH });
      expect(settled.record?.state).toBe("success");
    });

    it("ends the record and answers a timeout when the budget runs out before anything was signed; with one ledger left the client waits for it, then signs a new payment", async () => {
      let ledger = CURRENT;
      const { settle, store, hooks, metrics } = setup(() => new Promise(() => {}), {
        budgetMs: BUDGET_MS,
        latestLedger: async () => ledger,
      });
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      expect((await settled).response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.timeout,
        transaction: "",
        extra: { retryable: true, expirationLedger: EXPIRATION },
      });
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      // With one ledger left, too few for the pool, a retry gets the same answer, now not
      // retryable: wait for ledger EXPIRATION to close, then sign again. The record stays final.
      ledger = EXPIRATION - 1;
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
        errorMessage: expect.stringContaining("sign a new payment"),
        extra: { retryable: false, expirationLedger: EXPIRATION },
      });
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
      expect(metrics.value("settlement_budget_exhausted_total", { signed: "false" })).toBe(1);
    });

    it("never sends what it answered as timed out: the late onSigned rejects", async () => {
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      let signed: unknown = "not called";
      const { settle, store } = setup(
        async (opts) => {
          await signing;
          signed = await Promise.resolve(opts.onSigned!(HASH, BOUNDS)).then(
            () => "stored",
            (error: unknown) => error,
          );
          return new Promise(() => {});
        },
        { budgetMs: BUDGET_MS },
      );
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      expect((await settled).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      sign();
      await storeIdle();
      // The pool sends only after `onSigned` resolves; it rejects, so nothing is sent.
      expect(signed).toBeInstanceOf(Error);
      expect(await store.get(key)).toMatchObject({ state: "rejected", hashes: [] });
    });

    it("refuses to sign a record another writer ended, within the budget too", async () => {
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      let signed: unknown = "not called";
      const { settle, store } = setup(
        async (opts) => {
          await signing;
          signed = await Promise.resolve(opts.onSigned!(HASH, BOUNDS)).then(
            () => "stored",
            (error: unknown) => error,
          );
          return result();
        },
        { budgetMs: 5_000 },
      );
      const settled = settle(payload(), requirements);
      await storeIdle();
      expect((await store.get(key))?.state).toBe("claimed");
      // E.g. a repeat past the budget on another instance (`endUnsigned`).
      await store.transition(key, "claimed", {
        state: "rejected",
        errorReason: SETTLE_REASONS.timeout,
        updatedAt: Date.now(),
      });
      sign();
      await storeIdle();
      expect(signed).toBeInstanceOf(Error);
      await settled;
    });

    it("refuses to send a hash whose slow addHash ends after the budget answer (0009 decision 35)", async () => {
      let signed: unknown = "not called";
      const { settle, store } = setup(
        async (opts) => {
          signed = await Promise.resolve(opts.onSigned!(HASH, BOUNDS)).then(
            () => "sent",
            (error: unknown) => error,
          );
          return new Promise(() => {});
        },
        { budgetMs: 30 },
      );
      // The hash is stored at once, but the store answers only after the budget answer is out.
      const addHash = store.addHash.bind(store);
      store.addHash = async (...args) => {
        const added = await addHash(...args);
        await delay(60);
        return added;
      };
      const settled = settle(payload(), requirements);
      await elapse(60);
      expect((await settled).response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
        transaction: HASH,
      });
      // The answer named this hash, but the order (write, then the budget flag) keeps it unsent.
      expect(signed).toBeInstanceOf(Error);
    });

    it("refuses a rebuild's new hash once the budget answer named the first", async () => {
      let rebuild!: () => void;
      let second: unknown = "not called";
      const { settle, store } = setup(
        async (opts) => {
          await opts.onSigned?.(HASH, BOUNDS);
          // `txBadSeq`: the pool rebuilds and signs a new envelope.
          await new Promise<void>((resolve) => (rebuild = resolve));
          second = await Promise.resolve(opts.onSigned!("b".repeat(64), BOUNDS)).then(
            () => "stored",
            (error: unknown) => error,
          );
          return new Promise(() => {});
        },
        { budgetMs: BUDGET_MS },
      );
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      expect((await settled).response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
        transaction: HASH,
      });
      rebuild();
      await storeIdle();
      expect(second).toBeInstanceOf(Error);
      expect((await store.get(key))?.hashes).toEqual([HASH]);
    });

    it("answers from what the call knows when the store fails as the budget runs out", async () => {
      for (const signs of [false, true]) {
        await db.empty();
        const { settle, store, lines } = setup(
          async (opts) => {
            if (signs) await opts.onSigned?.(HASH, BOUNDS);
            return new Promise(() => {});
          },
          { budgetMs: BUDGET_MS },
        );
        vi.spyOn(store, "transition").mockRejectedValue(new Error("store down"));
        const settled = settle(payload(), requirements);
        await elapse(BUDGET_MS);
        const { response } = await settled;
        expect(response).toMatchObject(
          signs
            ? { errorReason: SETTLE_REASONS.pending, transaction: HASH }
            : { errorReason: SETTLE_REASONS.timeout, transaction: "" },
        );
        expect(lines.join("")).toContain("settlement_record_failed");
      }
    });

    it("answers within the budget when the store or beforeSubmit doesn't answer", async () => {
      const hung = () => new Promise<never>(() => {});
      const cases: [string, (s: ReturnType<typeof setup>) => void][] = [
        ["beforeSubmit", (s) => s.hooks.beforeSubmit.mockImplementationOnce(hung)],
        [
          "the budget's write",
          (s) => {
            s.hooks.beforeSubmit.mockImplementationOnce(async () => {
              await delay(BUDGET_MS + 10);
              return { allow: true };
            });
            vi.spyOn(s.store, "transition").mockImplementation(hung);
          },
        ],
      ];
      for (const [name, hang] of cases) {
        await db.empty();
        const s = setup(landing(), { budgetMs: BUDGET_MS });
        hang(s);
        let answered = false;
        const settled = s.settle(payload(), requirements).finally(() => {
          answered = true;
        });
        // The budget, then at most the store's grace: not a hang.
        await elapse(BUDGET_MS + STORE_GRACE_MS);
        expect(answered, name).toBe(true);
        const { response } = await settled;
        expect(response, name).toMatchObject({ errorReason: SETTLE_REASONS.timeout });
        expect(s.submit, name).not.toHaveBeenCalled();
      }
    });

    it("answers a timeout without claiming when the checks outlast the budget", async () => {
      // E.g. upstream verify failing over across every RPC URL, then the ledger read.
      const slow: Check = () => new Promise(() => {});
      const { settle, store, submit } = setup(landing(), { budgetMs: 30, check: slow });
      const settled = settle(payload(), requirements);
      await elapse(30);
      expect((await settled).response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(submit).not.toHaveBeenCalled();
      // Nothing is recorded, so the same payment can be sent again as it is.
      expect(await store.get(key)).toBeUndefined();
    });

    it("answers a timeout without claiming when the checks end just as the budget does", async () => {
      let time = 0;
      const check: Check = async (p, r) => {
        time = 5_000;
        return passing(p, r);
      };
      const { settle, store } = setup(landing(), { check, now: () => time });
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(await store.get(key)).toBeUndefined();
    });

    it("gives the claim at least the store's grace when the checks left almost no budget", async () => {
      let time = 0;
      const check: Check = async (p, r) => {
        time = 4_999;
        return passing(p, r);
      };
      const { settle, store } = setup(landing(), { check, now: () => time });
      // A real store's claim takes a few ms; a 1 ms bound would make it a 500 that still lands.
      const claim = store.claim.bind(store);
      vi.spyOn(store, "claim").mockImplementation(async (settlement) => {
        await delay(5);
        return claim(settlement);
      });
      const settled = settle(payload(), requirements);
      await elapse(5);
      await expect(settled).resolves.toBeDefined();
      expect(await store.get(key)).toBeDefined();
    });

    it("runs onFinal only after a beforeSubmit past the budget settles, so a late reservation is released", async () => {
      const order: string[] = [];
      let answer!: () => void;
      const { settle, hooks } = setup(landing(), { budgetMs: BUDGET_MS });
      hooks.beforeSubmit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () => {
              order.push("reserved");
              resolve({ allow: true });
            };
          }),
      );
      hooks.onFinal.mockImplementation(async () => {
        order.push("onFinal");
      });
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      expect((await settled).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      await elapse(10);
      expect(hooks.onFinal).not.toHaveBeenCalled();
      answer();
      await storeIdle();
      expect(order).toEqual(["reserved", "onFinal"]);
    });

    it("sends no hash whose write ended after the budget answer named another", async () => {
      let signed: unknown = "not called";
      const { settle, store } = setup(
        async (opts) => {
          signed = await Promise.resolve(opts.onSigned!(HASH, BOUNDS)).then(
            () => "stored",
            (error: unknown) => error,
          );
          return new Promise(() => {});
        },
        { budgetMs: BUDGET_MS },
      );
      // The hash is stored at once, but the store answers only after the budget answer.
      let answered!: () => void;
      const budgetAnswer = new Promise<void>((resolve) => (answered = resolve));
      const addHash = store.addHash.bind(store);
      vi.spyOn(store, "addHash").mockImplementation(async (...args) => {
        const added = await addHash(...args);
        await budgetAnswer;
        return added;
      });
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS);
      const { response } = await settled;
      answered();
      expect(response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
        transaction: HASH,
      });
      await storeIdle();
      expect(signed).toBeInstanceOf(Error);
    });

    it("ends a repeat's wait by its own budget, after a slow lookup", async () => {
      let time = 0;
      const { settle, store } = setup(landing("pending"), {
        budgetMs: 100,
        settleTimeoutMs: 100,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      });
      await settle(payload(), requirements);
      // The repeat's known-key lookup takes 40 of its 100 ms.
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementationOnce(async (k) => {
        time += 40;
        return get(k);
      });
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
      });
      expect(time).toBeLessThanOrEqual(105);
    });

    it("submits nothing when the checks and beforeSubmit used up the budget", async () => {
      const { settle, submit, store, hooks } = setup(landing(), { budgetMs: BUDGET_MS });
      hooks.beforeSubmit.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, BUDGET_MS + 10));
        return { allow: true };
      });
      const settled = settle(payload(), requirements);
      await elapse(BUDGET_MS + 10);
      expect((await settled).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(submit).not.toHaveBeenCalled();
      expect((await store.get(key))?.state).toBe("rejected");
    });

    it("keeps a repeat waiting past the settle timeout while nothing is signed yet, up to its budget", async () => {
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      const { settle, submit } = setup(
        async (opts) => {
          await signing;
          return landing()(opts);
        },
        { settleTimeoutMs: 100, budgetMs: 2_000 },
      );
      const first = settle(payload(), requirements);
      await elapse(5);
      const repeat = settle(payload(), requirements);
      // Past the settle timeout from the repeat's start (5 + 100).
      setTimeout(sign, 150);
      // Both answer by 160: the repeat's next read after the landing.
      await elapse(200);
      const answers = [(await repeat).response, (await first).response];
      expect(answers.filter((response) => response.success)).toHaveLength(1);
      expect(answers).toContainEqual(alreadySettled);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("counts a repeat's settle timeout from the hash it first sees, not from its start", async () => {
      // Signed at 150 ms, landed at 165 ms: past `settleTimeoutMs` from the repeat's start
      // (5 + 100), within it from the hash (150 + 100), with room for the store's writes.
      const { settle, submit } = setup(
        async (opts) => {
          await delay(150);
          await opts.onSigned?.(HASH, BOUNDS);
          await delay(15);
          return result();
        },
        { settleTimeoutMs: 100, budgetMs: 2_000 },
      );
      const first = settle(payload(), requirements);
      await elapse(5);
      const repeat = settle(payload(), requirements);
      // Both answer by 170: the repeat's next read after the landing.
      await elapse(200);
      const answers = [(await repeat).response, (await first).response];
      expect(answers.filter((response) => response.success)).toHaveLength(1);
      expect(answers).toContainEqual(alreadySettled);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("ends an unsigned record a repeat finds past the first call's budget, at once", async () => {
      // The refusal couldn't be stored, so the record stays `claimed` with no hash.
      const { settle, store, hooks } = setup(landing(), { budgetMs: BUDGET_MS });
      hooks.beforeSubmit.mockResolvedValueOnce({ allow: false, errorReason: "over_budget" });
      vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("store down"));
      await settle(payload(), requirements);
      expect((await store.get(key))?.state).toBe("claimed");
      await elapse(BUDGET_MS + 10);
      let answered = false;
      const repeat = settle(payload(), requirements).finally(() => {
        answered = true;
      });
      // Anchored on the claim, not on the repeat's own start: it answers with the clock still.
      await storeIdle();
      expect(answered).toBe(true);
      expect((await repeat).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(await store.addHash(key, HASH, Date.now())).toBe(false);
    });

    describe("a repeat that lost the claim to a call that started after it", () => {
      // The winner starts 150 ms after the losing call and claims at once; the loser's checks end
      // only once that claim is stored. Budget 300 ms: the loser's own ends at 300, the winner's
      // at 450.
      const race = (behaviour: Behaviour) => {
        let winnerClaimed!: () => void;
        const winnersClaim = new Promise<void>((resolve) => (winnerClaimed = resolve));
        let calls = 0;
        const afterWinnersClaim: Check = async (...args) => {
          if (calls++ === 0) await winnersClaim;
          return passing(...args);
        };
        const ctx = setup(behaviour, { budgetMs: 300, check: afterWinnersClaim });
        // The loser waits in its checks, so the first claim is the winner's.
        const claim = ctx.store.claim.bind(ctx.store);
        vi.spyOn(ctx.store, "claim").mockImplementationOnce(async (settlement) => {
          const claimed = await claim(settlement);
          winnerClaimed();
          return claimed;
        });
        const loser = ctx.settle(payload(), requirements);
        const winner = delay(150).then(() => ctx.settle(payload(), requirements));
        return { ...ctx, loser, winner };
      };

      it("leaves the record to the winner while its budget runs: a late reservation is released after it", async () => {
        const order: string[] = [];
        let reserve!: () => void;
        const { hooks, loser, winner } = race(landing());
        hooks.beforeSubmit.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              reserve = () => {
                order.push("reserved");
                resolve({ allow: true });
              };
            }),
        );
        hooks.onFinal.mockImplementation(async () => {
          order.push("onFinal");
        });
        await elapse(300);
        // By its own budget, before the winner's ends, and with no hash.
        expect((await loser).response).toMatchObject({
          errorReason: SETTLE_REASONS.pending,
          errorMessage: "not signed yet: repeat the same payment",
          transaction: "",
        });
        expect(hooks.onFinal).not.toHaveBeenCalled();
        await elapse(150);
        expect((await winner).response).toMatchObject({ errorReason: SETTLE_REASONS.timeout });
        reserve();
        await storeIdle();
        expect(order).toEqual(["reserved", "onFinal"]);
      });

      it("lets the winner sign after the loser's budget, while its own still runs", async () => {
        // The winner gets a channel once the loser answered by its budget, within its own.
        const run = race(async (opts) => {
          await run.loser;
          return landing()(opts);
        });
        await elapse(300);
        expect((await run.loser).response).toMatchObject({ errorReason: SETTLE_REASONS.pending });
        expect((await run.winner).response).toMatchObject({ success: true, transaction: HASH });
        expect((await run.store.get(key))?.state).toBe("success");
      });
    });

    it("stops the wait for a channel at the auth expiry when it comes before the budget", async () => {
      const { settle, submit } = setup(landing(), { budgetMs: 600_000, ledgerMs: 1_000 });
      const before = Date.now();
      await settle(payload(), requirements);
      const deadline = submit.mock.calls[0]![1]!.deadline!;
      // 12 ledgers left at an assumed 1 s each.
      expect(deadline - before).toBeGreaterThanOrEqual(12_000);
      expect(deadline - before).toBeLessThan(13_000);
    });
  });

  describe("a repeat of a payment nothing was sent for (0073)", () => {
    /** What the first call's late `onSigned` got: an error once a reopen took the record. */
    let late: unknown;
    beforeEach(() => {
      late = "not called";
    });
    /**
     * The first call's pool signing late, as the real pool does it: `onSigned`, and on its refusal
     * `submit()` rejects with `SignedHookError`, which reaches the call's own `finish`.
     */
    const lateSign = async (opts: SubmitOptions): Promise<SubmitResult> => {
      try {
        await opts.onSigned!(HASH, BOUNDS);
      } catch (error) {
        late = error;
        throw Object.assign(new SignedHookError(`onSigned failed, so ${HASH} was not sent`), {
          cause: error,
          attempts: [{ hash: HASH, sent: "no" }],
        });
      }
      late = "stored";
      return new Promise<never>(() => {});
    };

    /** The pool finds no channel in time once, then lands. */
    const noChannelThenLanding = (): Behaviour => {
      let calls = 0;
      return async (opts) => {
        if (calls++ === 0) throw new QueueTimeoutError("x");
        return landing()(opts);
      };
    };

    it("reopens the record for the identical payload while its auth entry is valid, and settles it once", async () => {
      const { settle, store, hooks, submit, lines, metrics } = setup(noChannelThenLanding());
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.noChannelInTime,
        extra: { retryable: true, expirationLedger: EXPIRATION },
      });

      const settled = await settle(payload(), requirements);
      expect(settled.response).toEqual({ success: true, transaction: HASH, network, payer });
      expect(settled.replay).toBeUndefined();
      expect(await store.get(key)).toMatchObject({
        state: "success",
        hashes: [HASH],
        reopened: 1,
      });
      expect(submit).toHaveBeenCalledTimes(2);
      expect(hooks.beforeSubmit.mock.calls.map(([context]) => context.reopened)).toEqual([0, 1]);
      expect(hooks.onFinal).toHaveBeenCalledTimes(2);
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          event: "settlement_reopened",
          settlementKey: key,
          errorReason: SETTLE_REASONS.noChannelInTime,
          reopened: 1,
        }),
      );
      expect(
        metrics.value("settlement_reopened_total", { reason: SETTLE_REASONS.noChannelInTime }),
      ).toBe(1);
      // Settled: a third call is a repeat of a success, never another reopen.
      expect((await settle(payload(), requirements)).response).toEqual(alreadySettled);
      expect(submit).toHaveBeenCalledTimes(2);
    });

    it("reopens once when the identical payload comes back twice at the same time", async () => {
      const { settle, store, submit, metrics } = setup(noChannelThenLanding());
      await settle(payload(), requirements);
      const answers = await Promise.all([
        settle(payload(), requirements),
        settle(payload(), requirements),
      ]);
      expect(
        metrics.value("settlement_reopened_total", { reason: SETTLE_REASONS.noChannelInTime }),
      ).toBe(1);
      expect(submit).toHaveBeenCalledTimes(2);
      expect(answers.filter(({ response }) => response.success)).toHaveLength(1);
      expect(await store.get(key)).toMatchObject({ state: "success", reopened: 1 });
    });

    it("never reopens a record claimed before 0073, and answers it as that release did (0073 decision 25)", async () => {
      // The release before 0073 answered "sign a new payment": a reopen now would let the old
      // payment land next to the new one. Its rows carry the migration's default, -1.
      const check = vi.fn<Check>(passing);
      const { settle, store, submit } = setup(noChannelThenLanding(), { check });
      const first = await settle(payload(), requirements);
      expect(first.response.extra).toMatchObject({ retryable: true });
      await db.pool.query("UPDATE settlements SET reopened = -1 WHERE key = $1", [key]);
      const answer = await settle(payload(), requirements);
      expect(answer.replay).toBe(true);
      expect(answer.response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.noChannelInTime,
      });
      expect(answer.response).not.toHaveProperty("extra.retryable");
      expect(submit).toHaveBeenCalledTimes(1);
      // Not even the checks a reopen runs first: it is answered from the record.
      expect(check).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toMatchObject({ state: "rejected", reopened: -1 });
    });

    it("reopens with exactly two ledgers left, the pool's floor", async () => {
      let ledger = CURRENT;
      const { settle, store } = setup(noChannelThenLanding(), { latestLedger: async () => ledger });
      ledger = EXPIRATION - 2;
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.noChannelInTime,
        extra: { retryable: true, expirationLedger: EXPIRATION },
      });
      expect((await settle(payload(), requirements)).response.success).toBe(true);
      expect(await store.get(key)).toMatchObject({ state: "success", reopened: 1 });
    });

    it("says to wait for the expiration ledger at one ledger left, and to sign again after it, without the checks or a reopen", async () => {
      let ledger = CURRENT;
      const check = vi.fn<Check>(passing);
      const { settle, store, submit } = setup(noChannelThenLanding(), {
        check,
        latestLedger: async () => ledger,
      });
      await settle(payload(), requirements);
      const answer = (errorMessage: string) => ({
        success: false,
        errorReason: SETTLE_REASONS.noChannelInTime,
        errorMessage,
        extra: { retryable: false, expirationLedger: EXPIRATION },
        payer,
        transaction: "",
        network,
      });
      // Too late for the pool, which needs two ledgers left, but valid in the expiration ledger.
      ledger = EXPIRATION - 1;
      const settled = await settle(payload(), requirements);
      expect(settled.response).toEqual(
        answer(
          `nothing was sent, and it is too late to settle here, but the auth entry may still ` +
            `land in ledger ${EXPIRATION}: once that ledger has closed, sign a new payment`,
        ),
      );
      expect(settled.replay).toBe(true);
      ledger = EXPIRATION;
      expect((await settle(payload(), requirements)).response).toEqual(
        answer(
          `nothing was sent, and the auth entry expired with ledger ${EXPIRATION}: sign a new payment`,
        ),
      );
      expect(check).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toMatchObject({ state: "rejected", reopened: 0 });
    });

    it("answers the stored outcome, still retryable, when the latest ledger can't be read", async () => {
      let down = false;
      const { settle, store, submit } = setup(noChannelThenLanding(), {
        latestLedger: async () => {
          if (down) throw new Error("rpc down");
          return CURRENT;
        },
      });
      await settle(payload(), requirements);
      down = true;
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.noChannelInTime,
        errorMessage:
          `nothing was sent: repeat the same payment; once the network is past ledger ` +
          `${EXPIRATION}, sign a new payment instead`,
        extra: { retryable: true, expirationLedger: EXPIRATION },
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toMatchObject({ state: "rejected", reopened: 0 });
    });

    it("marks a timeout the budget gave during the checks retryable, and records nothing", async () => {
      // Before the claim: nothing was sent and nothing stored, so the same payment may come back.
      const { settle, store, submit } = setup(landing(), {
        budgetMs: BUDGET_MS,
        check: () => new Promise(() => {}),
      });
      expect((await settle(payload(), requirements)).response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.timeout,
        transaction: "",
        errorMessage:
          `nothing was sent: repeat the same payment while the latest ledger is at most ` +
          `${EXPIRATION - 2}; once the network is past ledger ${EXPIRATION}, sign a new payment instead`,
        extra: { retryable: true, expirationLedger: EXPIRATION },
      });
      expect(submit).not.toHaveBeenCalled();
      expect(await store.get(key)).toBeUndefined();
    });

    it("answers within about a second, still retryable, when the latest ledger read never answers", async () => {
      // The answer's ledger read is bounded by 1 s of its own: a hung RPC can't hold the answer.
      const { settle } = setup(noChannelThenLanding(), {
        latestLedger: () => new Promise<number>(() => {}),
      });
      const started = Date.now();
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.noChannelInTime,
        errorMessage:
          `nothing was sent: repeat the same payment; once the network is past ledger ` +
          `${EXPIRATION}, sign a new payment instead`,
        extra: { retryable: true, expirationLedger: EXPIRATION },
      });
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(900);
      expect(took).toBeLessThan(2_500);
    }, 4_000);

    it("still refuses a different payload on the same nonce", async () => {
      const { settle, store, submit } = setup(noChannelThenLanding());
      await settle(payload(), requirements);
      const other = { ...requirements, extra: { merchant: "another" } };
      expect((await settle({ ...payload(), accepted: other }, other)).response).toMatchObject({
        errorReason: SETTLE_REASONS.nonceUsed,
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toMatchObject({ state: "rejected", reopened: 0 });
    });

    it("answers the checks' refusal and leaves the record when the payment no longer passes them", async () => {
      let failing = false;
      const check = vi.fn<Check>(async (p, r) =>
        failing
          ? {
              response: {
                isValid: false,
                invalidReason: "invalid_exact_stellar_payload_simulation_failed",
                payer,
              },
            }
          : passing(p, r),
      );
      const { settle, store, submit } = setup(noChannelThenLanding(), { check });
      await settle(payload(), requirements);
      failing = true;
      const settled = await settle(payload(), requirements);
      expect(settled.response).toMatchObject({
        success: false,
        errorReason: "invalid_exact_stellar_payload_simulation_failed",
      });
      expect(settled).toMatchObject({ key, replay: true });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.noChannelInTime,
        reopened: 0,
      });
    });

    it("never reopens a record with a hash, and answers it as stored", async () => {
      let calls = 0;
      const { settle, store, submit } = setup(async (opts) => {
        if (calls++ > 0) return result();
        await opts.onSigned?.(HASH, BOUNDS);
        throw Object.assign(new NoChannelsError("x"), { attempts: [{ hash: HASH, sent: "no" }] });
      });
      await settle(payload(), requirements);
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.noChannels,
        hashes: [HASH],
      });
      expect((await settle(payload(), requirements)).response).toEqual({
        success: false,
        errorReason: SETTLE_REASONS.noChannels,
        payer,
        transaction: HASH,
        network,
      });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("never lets a waiting repeat end a claim reopened since it read the earlier one (0073 decision 19)", async () => {
      // The repeat reads the first claim and waits out its budget. Meanwhile that claim ends and
      // another call reopens the record: still `claimed` with no hash, but a new claim. The
      // repeat's `endUnsigned` passes the version it read, so it can't end the new claim, and it
      // answers that nothing is signed yet instead of "sign a new payment".
      const { settle, store } = setup(landing(), { budgetMs: BUDGET_MS });
      const fingerprint = fingerprintOf(payload(), requirements);
      await store.claim({
        key,
        network,
        payer,
        nonce: "7",
        fingerprint,
        paymentPayload: payload(),
        paymentRequirements: requirements,
        createdAt: Date.now(),
      });
      const get = store.get.bind(store);
      let reads = 0;
      vi.spyOn(store, "get").mockImplementation(async (k) => {
        // After the repeat's first read: the earlier claim ends and another call reopens it.
        if (reads++ === 1) {
          await store.transition(key, "claimed", {
            state: "rejected",
            errorReason: SETTLE_REASONS.noChannelInTime,
            updatedAt: Date.now(),
          });
          await store.reopen(key, fingerprint, [SETTLE_REASONS.noChannelInTime], Date.now());
        }
        return get(k);
      });
      expect((await settle(payload(), requirements)).response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.pending,
        errorMessage: "not signed yet: repeat the same payment",
        transaction: "",
      });
      expect(await get(key)).toMatchObject({ state: "claimed", reopened: 1, hashes: [] });
    });

    it("reopens a record reconciliation closed as interrupted, and settles it once", async () => {
      const { settle, store, submit } = setup();
      await store.claim({
        key,
        network,
        payer,
        nonce: "7",
        fingerprint: fingerprintOf(payload(), requirements),
        paymentPayload: payload(),
        paymentRequirements: requirements,
        createdAt: 0,
      });
      await store.transition(key, "claimed", {
        state: "rejected",
        errorReason: SETTLE_REASONS.interrupted,
        updatedAt: 1,
      });
      expect((await settle(payload(), requirements)).response.success).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toMatchObject({ state: "success", reopened: 1 });
    });

    it("never stores the earlier claim's late hash on the reopened claim", async () => {
      const OTHER = "b".repeat(64);
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      let calls = 0;
      const { settle, store } = setup(
        async (opts) => {
          if (calls++ > 0) return landing("success", OTHER)(opts);
          await signing;
          return lateSign(opts);
        },
        { budgetMs: BUDGET_MS },
      );
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      expect((await settle(payload(), requirements)).response.success).toBe(true);
      sign();
      await vi.waitFor(() => expect(late).toBeInstanceOf(Error));
      expect(await store.get(key)).toMatchObject({ state: "success", hashes: [OTHER] });
    });

    it("never ends the reopened claim from the earlier claim's late refusal (0073 decision 24)", async () => {
      // The first call's pool signs after a repeat reopened the record and signed, but before the
      // repeat is final. The refused hash rejects its `submit()` as the real pool does, and its
      // `finish` must not end the repeat's claim: that transaction can still land. The repeat has
      // a budget of its own, long enough that only the earlier claim could end its record.
      const OTHER = "b".repeat(64);
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      let land!: () => void;
      const lands = new Promise<void>((resolve) => (land = resolve));
      const first = setup(
        async (opts) => {
          await signing;
          return lateSign(opts);
        },
        { budgetMs: BUDGET_MS },
      );
      const repeat = setup(
        async (opts) => {
          await opts.onSigned?.(OTHER, BOUNDS);
          await lands;
          return result("success", OTHER);
        },
        { budgetMs: 5_000 },
      );
      expect((await first.settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      const answer = repeat.settle(payload(), requirements);
      await vi.waitFor(async () =>
        expect(await repeat.store.get(key)).toMatchObject({ state: "signed", hashes: [OTHER] }),
      );
      const finals = vi.mocked(first.hooks.onFinal).mock.calls.length;
      sign();
      await vi.waitFor(() => expect(late).toBeInstanceOf(Error));
      await first.settle.drain();
      expect(await repeat.store.get(key)).toMatchObject({
        state: "signed",
        reopened: 1,
        hashes: [OTHER],
      });
      // Its `onFinal` never ran on the repeat's record either.
      expect(vi.mocked(first.hooks.onFinal).mock.calls.length).toBe(finals);
      land();
      expect((await answer).response.success).toBe(true);
    });

    it("never ends a reopened claim that hasn't signed yet from the earlier claim's late refusal", async () => {
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      let proceed!: () => void;
      const proceeds = new Promise<void>((resolve) => (proceed = resolve));
      const first = setup(
        async (opts) => {
          await signing;
          return lateSign(opts);
        },
        { budgetMs: BUDGET_MS },
      );
      const repeat = setup(
        async (opts) => {
          await proceeds;
          return landing("success")(opts);
        },
        { budgetMs: 5_000 },
      );
      expect((await first.settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      const answer = repeat.settle(payload(), requirements);
      await vi.waitFor(async () =>
        expect(await repeat.store.get(key)).toMatchObject({ state: "claimed", reopened: 1 }),
      );
      sign();
      await vi.waitFor(() => expect(late).toBeInstanceOf(Error));
      await first.settle.drain();
      expect(await repeat.store.get(key)).toMatchObject({
        state: "claimed",
        reopened: 1,
        hashes: [],
      });
      proceed();
      expect((await answer).response.success).toBe(true);
    });

    it("never stores a hash for the earlier claim when another process ended and reopened it", async () => {
      // Across a lease handover: the first call is still within its own budget, so only the
      // claim it passes to `addHash` stops its late hash.
      const OTHER = "b".repeat(64);
      let signFirst!: () => void;
      const firstSigns = new Promise<void>((resolve) => (signFirst = resolve));
      let land!: () => void;
      const lands = new Promise<void>((resolve) => (land = resolve));
      const first = setup(async (opts) => {
        await firstSigns;
        return lateSign(opts);
      });
      const other = setup(
        async (opts) => {
          await opts.onSigned?.(OTHER, BOUNDS);
          await lands;
          return result("success", OTHER);
        },
        { budgetMs: BUDGET_MS },
      );
      void first.settle(payload(), requirements);
      await vi.waitFor(async () => expect(await other.store.get(key)).toBeDefined());
      // The other process's repeat ends the claim by its own, shorter budget.
      expect((await other.settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      const reopened = other.settle(payload(), requirements);
      await vi.waitFor(async () =>
        expect(await other.store.get(key)).toMatchObject({ state: "signed", hashes: [OTHER] }),
      );
      signFirst();
      await vi.waitFor(() => expect(late).toBeInstanceOf(Error));
      land();
      await reopened;
      // Its budget answer may come before the landing; the submission finishes the record.
      await vi.waitFor(async () =>
        expect(await other.store.get(key)).toMatchObject({ state: "success", hashes: [OTHER] }),
      );
    });

    it("answers without retry details when the payload's auth entry can't be read", async () => {
      const { settle } = setup(landing(), {
        budgetMs: BUDGET_MS,
        check: () => new Promise(() => {}),
      });
      const garbled = { ...payload(), payload: { transaction: "not a transaction" } };
      expect((await settle(garbled, requirements)).response).toEqual({
        success: false,
        errorReason: SETTLE_REASONS.timeout,
        payer: undefined,
        transaction: "",
        network,
      });
    });

    it("never reopens a record a hook refused", async () => {
      const { settle, store, hooks, submit } = setup();
      hooks.beforeSubmit.mockResolvedValueOnce({ allow: false, errorReason: "spend_refused" });
      await settle(payload(), requirements);
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: "spend_refused",
      });
      expect(submit).not.toHaveBeenCalled();
      expect(await store.get(key)).toMatchObject({ state: "rejected", reopened: 0 });
    });
  });
});

describe("attempt states (0019 decision 7)", () => {
  const OTHER = "b".repeat(64);

  it("stores the hash with its bounds, marks it sent, and records the outcome per hash", async () => {
    const seen: (string | undefined)[] = [];
    const { settle, store } = setup(async (opts) => {
      await opts.onSigned?.(OTHER, BOUNDS);
      await opts.onSigned?.(HASH, BOUNDS);
      opts.onSent?.(HASH);
      await delay(5);
      seen.push((await store.attempts(key)).at(-1)?.state);
      // The first envelope was refused with `txBadSeq`, the rebuild landed.
      return {
        ...result("success"),
        attempts: [
          { hash: OTHER, sent: "yes" },
          { hash: HASH, sent: "yes" },
        ],
      };
    });
    const settled = await settle(payload(), requirements);
    expect(settled.response.success).toBe(true);
    expect(seen).toEqual(["sent"]);
    expect(await store.attempts(key)).toEqual([
      {
        hash: OTHER,
        state: "dead",
        errorCode: "txBadSeq",
        channel: "GCHANNEL",
        ...BOUNDS,
        updatedAt: expect.any(Number),
      },
      {
        hash: HASH,
        state: "landed",
        channel: "GCHANNEL",
        ...BOUNDS,
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("leaves a pending attempt sent, for reconciliation to resolve", async () => {
    const { settle, store } = setup(landing("pending"));
    await settle(payload(), requirements);
    expect(await store.get(key)).toMatchObject({ state: "pending" });
    expect((await store.attempts(key)).map((a) => a.state)).toEqual(["sent"]);
  });

  it("answers the same when the sent mark fails, and logs it as a warning, not a record failure", async () => {
    const { settle, store, lines, metrics } = setup(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      opts.onSent?.(HASH);
      await delay(5);
      return result("success");
    });
    store.markAttempts = vi.fn(() => Promise.reject(new Error("store down")));
    const settled = await settle(payload(), requirements);
    expect(settled.response.success).toBe(true);
    expect(lines.some((line) => line.includes('"settlement_attempt_mark_failed"'))).toBe(true);
    expect(lines.some((line) => line.includes('"settlement_record_failed"'))).toBe(false);
    expect(metrics.value("settlement_record_failures_total")).toBe(0);
  });
});

describe("with reconciliation (0019)", () => {
  /** A settler and a reconciler sharing one store and one `records`, as `buildSettlement` builds. */
  function shared(behaviour: Behaviour, answer: rpc.Api.GetTransactionResponse) {
    const store = db.stores().settlements;
    const hooks = {
      onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
      onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
    };
    const logger = jsonLogger("error", () => {});
    const metrics = memoryMetrics();
    const records = createRecords({ network, store, hooks, logger, metrics });
    const { settle } = setup(behaviour, { store, records });
    const reconcilerOn = (r = records) =>
      createReconciler({
        network,
        store,
        rpc: { getTransaction: async () => answer },
        records: r,
        logger,
        metrics,
        budgetMs: 5_000,
      });
    return { store, hooks, logger, metrics, records, settle, reconcilerOn };
  }

  const notFound = (latestLedger: number) =>
    ({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      latestLedger,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    }) as unknown as rpc.Api.GetTransactionResponse;

  it("marks a success answered without the store's mark once the store is back (decision 9)", async () => {
    const { store, records, settle, reconcilerOn } = shared(landing(), notFound(1));
    vi.spyOn(store, "markSuccessAnswered").mockRejectedValueOnce(new Error("store down"));
    expect((await settle(payload(), requirements)).response.success).toBe(true);
    // The key waits for the next sweep.
    expect(records.unmarked.has(key)).toBe(true);
    await reconcilerOn().sweep();
    expect((await store.get(key))?.successAnsweredAt).toEqual(expect.any(Number));
    expect((await settle(payload(), requirements)).response).toEqual(alreadySettled);
  });

  it("answers a success once when a sweep stores it while the call reads back (decision 32)", async () => {
    const landed = {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 1001,
      resultXdr: { feeCharged: () => ({ toBigInt: () => 41_000n }) },
    } as unknown as rpc.Api.GetTransactionResponse;
    const { store, settle, reconcilerOn } = shared(landing(), landed);
    // The success write fails, and the call's read-back waits until the store is back.
    const transition = store.transition.bind(store);
    let readBack: (() => void) | undefined;
    vi.spyOn(store, "transition").mockImplementation(async (k, from, update, version) => {
      if (update.state !== "success" || readBack) return transition(k, from, update, version);
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementationOnce(async (gk) => {
        await new Promise<void>((resolve) => (readBack = resolve));
        return get(gk);
      });
      throw new Error("store down");
    });
    const first = settle(payload(), requirements);
    await vi.waitFor(() => expect(readBack).toBeDefined());
    // Meanwhile a sweep stores the success, and a repeat asks for it: the store's mark goes to
    // the repeat, so the call that read back answers it as already answered.
    expect(await reconcilerOn().sweep()).toMatchObject({ success: 1 });
    expect((await settle(payload(), requirements)).response.success).toBe(true);
    readBack!();
    expect((await first).response).toEqual(alreadySettled);
  });

  it("finishes a payment whose process crashed between signing and sending", async () => {
    const { store, hooks, logger, metrics, settle, reconcilerOn } = shared(async (opts) => {
      await opts.onSigned?.(HASH, BOUNDS);
      return new Promise(() => {}); // the process stops here
    }, notFound(BOUNDS.maxLedger));
    void settle(payload(), requirements);
    await vi.waitFor(async () => expect(await store.attempts(key)).toHaveLength(1));
    // After the restart: a new process, with its own records, on the same store.
    const restarted = createRecords({ network, store, hooks, logger, metrics });
    expect(await reconcilerOn(restarted).sweep()).toMatchObject({ expired: 1 });
    expect(await store.get(key)).toMatchObject({
      state: "expired",
      errorReason: SETTLE_REASONS.expired,
    });
    expect((await store.attempts(key))[0]?.state).toBe("dead");
    expect(hooks.onFinal).toHaveBeenCalledWith(expect.objectContaining({ key }), "resolved");
  });
});

describe("expectTransfer", () => {
  const transfer = transferEvent;
  const check = expectTransfer({ asset, from: payer, to: payTo, amount: 1000n });

  it("accepts exactly the expected transfer", () => {
    expect(() => check(sim(transfer()))).not.toThrow();
  });

  it.each([
    ["no transfer", sim()],
    ["two transfers", sim(transfer(), transfer())],
    ["another amount", sim(transfer(payer, payTo, nativeToScVal(999n, { type: "i128" })))],
    ["another recipient", sim(transfer(payer, Keypair.random().publicKey()))],
    ["another sender", sim(transfer(Keypair.random().publicKey()))],
    [
      "another token",
      sim(transfer(payer, payTo, undefined, StrKey.encodeContract(Buffer.alloc(32, 9)))),
    ],
    [
      "another contract event",
      sim(
        transfer(),
        event([xdr.ScVal.scvSymbol("mint"), xdr.ScVal.scvVoid(), xdr.ScVal.scvVoid()]),
      ),
    ],
  ])("refuses %s", (_, simulation) => {
    expect(() => check(simulation)).toThrow();
  });
});
