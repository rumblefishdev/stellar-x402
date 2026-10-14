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
  type rpc,
} from "@stellar/stellar-sdk";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import {
  FeeLimitError,
  LedgerBoundError,
  NoChannelsError,
  QueueTimeoutError,
  SignedHookError,
  SimulationCheckError,
  SimulationError,
  type SubmitOptions,
  type SubmitResult,
} from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { MemorySettlementStore } from "../src/adapters/memory.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import {
  SETTLE_REASONS,
  createSettler,
  expectTransfer,
  type SettlerDeps,
  type Submitter,
} from "../src/settlement/settle.js";
import { createChecker, type Check } from "../src/settlement/verify.js";

// `attemptsOf` reads a private WeakMap that only the real submitter fills; tests put the attempts
// on the error instead.
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
  // Differs from the requirements, so the tests see which one the settler uses.
  accepted: { ...requirements, amount: "1" },
  payload: { transaction: transaction(auth).toXDR() },
});

/** A check that accepts any payload: the `/verify` checks have their own tests. */
const passing: Check = async (p) => {
  const tx = TransactionBuilder.fromXDR(
    (p.payload as { transaction: string }).transaction,
    Networks.TESTNET,
  ) as ReturnType<typeof transaction>;
  return {
    response: { isValid: true, payer },
    verified: { transaction: tx, payer, expirationLedger: EXPIRATION, currentLedger: CURRENT },
  };
};

type Behaviour = (opts: SubmitOptions) => Promise<SubmitResult>;

/** Signs (stores the hash through `onSigned`), then answers with `status`. */
const landing =
  (status: SubmitResult["status"] = "success", hash = HASH): Behaviour =>
  async (opts) => {
    await opts.onSigned?.(hash);
    return {
      status,
      hash,
      channel: "GCHANNEL",
      ledger: status === "success" || status === "failed" ? CURRENT + 1 : undefined,
      feeCharged: 41_000n,
      attempts: [{ hash, sent: "yes" }],
    };
  };

function setup(behaviour: Behaviour = landing(), overrides: Partial<SettlerDeps> = {}) {
  const order: string[] = [];
  const store = new MemorySettlementStore();
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
    expect(opts?.checkSimulation).toBeTypeOf("function");

    const record = await store.get(key);
    expect(record).toMatchObject({ state: "success", hashes: [HASH], ledger: CURRENT + 1 });
    expect(settled.record).toEqual(record);
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
    // `onSuccess` waits for the route to send the response.
    expect(hooks.onSuccess).not.toHaveBeenCalled();
    settled.afterResponse!();
    expect(hooks.onSuccess).toHaveBeenCalledWith(record, "settle");
  });

  it("submits exactly once for concurrent calls with one settlement key", async () => {
    const { settle, submit, hooks } = setup(async (opts) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return landing()(opts);
    });
    const p = payload();
    const answers = await Promise.all(Array.from({ length: 5 }, () => settle(p, requirements)));

    expect(submit).toHaveBeenCalledTimes(1);
    for (const { response } of answers)
      expect(response).toMatchObject({ success: true, transaction: HASH });
    expect(answers.filter((answer) => answer.afterResponse)).toHaveLength(1);
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
  });

  it("answers a repeat with the same fingerprint from the record, without submitting or onSuccess", async () => {
    const { settle, submit } = setup();
    await settle(payload(), requirements);
    const repeat = await settle(payload(), requirements);
    expect(repeat.response).toEqual({ success: true, transaction: HASH, network, payer });
    expect(repeat.record?.state).toBe("success");
    expect(repeat.afterResponse).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
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

    expect((await settle(payload(), requirements)).response).toEqual({
      success: true,
      transaction: HASH,
      network,
      payer,
    });
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
      await opts.onSigned?.(HASH);
      await landed;
      return landing()(opts);
    });
    const first = settle(payload(), requirements);
    await vi.waitFor(async () => expect((await store.get(key))?.state).toBe("signed"));
    const repeat = settle(payload(), requirements);
    setTimeout(land, 30);
    expect((await repeat).response).toMatchObject({ success: true, transaction: HASH });
    expect((await first).response).toMatchObject({ success: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("answers settlement_pending to a repeat once the settle timeout runs out", async () => {
    const { settle } = setup(
      async (opts) => {
        await opts.onSigned?.(HASH);
        return new Promise(() => {});
      },
      { settleTimeoutMs: 30, budgetMs: 50 },
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

  it("refuses a repeat with a different fingerprint, never returning the stored outcome", async () => {
    const { settle, submit, metrics } = setup();
    await settle(payload(), requirements);
    const other = { ...requirements, extra: { merchant: "another" } };
    const answer = await settle({ ...payload(), accepted: other }, other);
    expect(answer.response).toEqual({
      success: false,
      errorReason: SETTLE_REASONS.nonceUsed,
      errorMessage: "this payer's nonce was already used for a different payment",
      payer,
      transaction: "",
      network,
    });
    expect(answer.record).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(metrics.value("settle_nonce_reuse_total")).toBe(1);
  });

  it.each([
    ["no auth entry for the payer", [authEntry(Keypair.random().publicKey(), "1")]],
    ["two auth entries for the payer", [authEntry(payer, "1"), authEntry(payer, "2")]],
  ])("rejects a payload with %s, without claiming", async (_, auth) => {
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
    [new Error("rpc down"), "unexpected_settle_error"],
  ])("maps a thrown %s to a fixed reason and ends the record", async (error, reason) => {
    const { settle, store, hooks } = setup(async () => {
      throw error;
    });
    expect((await settle(payload(), requirements)).response).toEqual({
      success: false,
      errorReason: reason,
      payer,
      transaction: "",
      network,
    });
    expect(await store.get(key)).toMatchObject({ state: "rejected", errorReason: reason });
    expect(hooks.onFinal).toHaveBeenCalledTimes(1);
  });

  it("warns and counts a fee or ledger refusal, which means the pool disagreed with /verify", async () => {
    for (const [error, reason] of [
      [new FeeLimitError("x"), "settle_exact_stellar_fee_exceeds_maximum"],
      [new LedgerBoundError("x"), "settle_exact_stellar_signature_expiration_too_soon"],
    ] as const) {
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
      expect(metrics.value("settle_refused_after_verify_total", { reason })).toBe(1);
    }
    // Other refusals are not a drift between the two.
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
    const { settle, store, hooks } = setup(async (opts) => {
      await opts.onSigned?.(HASH);
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
    expect(settled.afterResponse).toBeUndefined();
  });

  it("treats a beforeSubmit that throws as a refusal", async () => {
    const { settle, submit, hooks, metrics } = setup();
    hooks.beforeSubmit.mockRejectedValueOnce(new Error("store down"));
    expect((await settle(payload(), requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.refused,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(metrics.value("settlement_hook_failures_total", { hook: "beforeSubmit" })).toBe(1);
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

  describe("settle budget (ADR 0011)", () => {
    it("answers settlement_pending with the hash once the budget runs out after signing, and catalogs a late success", async () => {
      let land!: () => void;
      const { settle, store, hooks } = setup(
        async (opts) => {
          await opts.onSigned?.(HASH);
          await new Promise<void>((resolve) => (land = resolve));
          return landing()(opts);
        },
        { budgetMs: 30 },
      );
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: "settlement_pending",
        transaction: HASH,
      });
      land();
      await vi.waitFor(async () => expect((await store.get(key))?.state).toBe("success"));
      await vi.waitFor(() =>
        expect(hooks.onSuccess).toHaveBeenCalledWith(expect.anything(), "resolved"),
      );
    });

    it("answers a retryable timeout when the budget runs out before anything was signed", async () => {
      const { settle, store, hooks } = setup(() => new Promise(() => {}), { budgetMs: 30 });
      expect((await settle(payload(), requirements)).response).toMatchObject({
        success: false,
        errorReason: SETTLE_REASONS.timeout,
        transaction: "",
      });
      expect(await store.get(key)).toMatchObject({
        state: "rejected",
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(hooks.onFinal).toHaveBeenCalledTimes(1);
    });

    it("never sends what it answered as timed out: a late sign is refused", async () => {
      let sign!: () => void;
      const signing = new Promise<void>((resolve) => (sign = resolve));
      const { settle, store } = setup(
        async (opts) => {
          await signing;
          return landing()(opts);
        },
        { budgetMs: 30 },
      );
      expect((await settle(payload(), requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.timeout,
      });
      expect(await store.addHash(key, HASH, Date.now())).toBe(false);
      sign();
      // `onSigned` throws on the final record, so the pool sends nothing (a `SignedHookError`).
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await store.get(key)).toMatchObject({ state: "rejected", hashes: [] });
    });

    it("submits nothing when the checks and beforeSubmit used up the budget", async () => {
      const { settle, submit, store, hooks } = setup(landing(), { budgetMs: 30 });
      hooks.beforeSubmit.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { allow: true };
      });
      expect((await settle(payload(), requirements)).response).toMatchObject({
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
        { settleTimeoutMs: 20, budgetMs: 2_000 },
      );
      const first = settle(payload(), requirements);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const repeat = settle(payload(), requirements);
      setTimeout(sign, 60);
      expect((await repeat).response).toMatchObject({ success: true, transaction: HASH });
      expect((await first).response).toMatchObject({ success: true });
      expect(submit).toHaveBeenCalledTimes(1);
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
});

describe("expectTransfer", () => {
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
  const transfer = (from = payer, to = payTo, data?: xdr.ScVal, contract?: string) =>
    event(
      [
        xdr.ScVal.scvSymbol("transfer"),
        nativeToScVal(from, { type: "address" }),
        nativeToScVal(to, { type: "address" }),
      ],
      data,
      contract,
    );
  const check = expectTransfer({ asset, from: payer, to: payTo, amount: 1000n });
  const sim = (...events: xdr.DiagnosticEvent[]) =>
    ({ events }) as unknown as rpc.Api.SimulateTransactionSuccessResponse;

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
