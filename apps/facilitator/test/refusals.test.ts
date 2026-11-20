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
} from "@stellar/stellar-sdk";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "../src/logger.js";
import { StoreUnavailableError, verifyWithRefusals } from "../src/settlement/refusals.js";
import { SETTLE_REASONS } from "../src/settlement/reasons.js";
import { REFUSAL_HORIZON_LEDGERS } from "../src/settlement/settle.js";
import type { Verify } from "../src/settlement/verify.js";
import { testDatabase } from "./database.js";

const network = STELLAR_NETWORKS.testnet;
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const EXPIRATION = 1_012;
const FEE = "invalid_exact_stellar_payload_fee_exceeds_maximum";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

function payload(nonce = "7"): PaymentPayload {
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(payer).toScAddress(),
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
  const transaction = new TransactionBuilder(new Account(payer, "1"), {
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
        auth: [auth],
      }),
    )
    .setTimebounds(0, 2_000_000_000)
    .build();
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: transaction.toXDR() },
  };
}

const key = `${network}:${payer}:7` as const;
const advice =
  `this payment will not settle here, but its auth entry may still land in ledger ` +
  `${EXPIRATION}: sign a new payment once that ledger has closed`;
const feeRefusal: VerifyResponse = {
  isValid: false,
  invalidReason: FEE,
  invalidMessage: "too high",
  payer,
};

describe("verifyWithRefusals (0086)", () => {
  const db = testDatabase();
  beforeEach(db.empty);
  const lines: string[] = [];

  const setup = (
    store = db.stores().settlements,
    latestLedger: () => Promise<number> = async () => 1_000,
  ) => {
    const inner = vi.fn<Verify>(async () => feeRefusal);
    const verify = verifyWithRefusals(inner, {
      network,
      store,
      logger: jsonLogger("debug", (line) => lines.push(line)),
      latestLedger,
      now: () => 5_000,
      storeTimeoutMs: 200,
    });
    return { inner, verify, store };
  };

  it("records a refusal and answers it with when a new signature is safe", async () => {
    const { verify, store } = setup();
    expect(await verify(payload(), requirements)).toEqual({
      ...feeRefusal,
      invalidMessage: `${advice}; too high`,
      extra: { expirationLedger: EXPIRATION },
    });
    expect(await store.get(key)).toMatchObject({
      state: "refused",
      errorReason: FEE,
      errorMessage: "too high",
      createdAt: 5_000,
    });
  });

  it("answers the same payment from its record without the checks, once fees dropped", async () => {
    const { inner, verify } = setup();
    const first = await verify(payload(), requirements);
    inner.mockResolvedValue({ isValid: true, payer });
    expect(await verify(payload(), requirements)).toEqual(first);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("keeps our own code next to upstream's reason for the repeat", async () => {
    const { inner, verify, store } = setup();
    inner.mockResolvedValueOnce({ ...feeRefusal, extra: { reason: "our_code" } });
    const first = await verify(payload(), requirements);
    expect(first.extra).toEqual({ reason: "our_code", expirationLedger: EXPIRATION });
    expect(await store.get(key)).toMatchObject({ errorDetail: "our_code" });
    expect(await verify(payload(), requirements)).toEqual(first);
  });

  it("verifies another payment of the payer as usual", async () => {
    const { inner, verify } = setup();
    await verify(payload(), requirements);
    inner.mockResolvedValue({ isValid: true, payer });
    expect(await verify(payload("8"), requirements)).toEqual({ isValid: true, payer });
  });

  it("leaves a valid answer and a payload without a key as they are, recording nothing", async () => {
    const { inner, verify, store } = setup();
    inner.mockResolvedValueOnce({ isValid: true, payer });
    expect(await verify(payload(), requirements)).toEqual({ isValid: true, payer });
    const keyless = { ...payload(), payload: { transaction: "AAAA" } };
    expect(await verify(keyless, requirements)).toEqual(feeRefusal);
    expect(await store.get(key)).toBeUndefined();
  });

  it("answers a refusal as before when another record answers for the key", async () => {
    const { verify, store } = setup();
    const { claimed } = await store.claim({
      key,
      network,
      payer,
      nonce: "7",
      fingerprint: "fp-other",
      paymentPayload: payload(),
      paymentRequirements: requirements,
      createdAt: 1_000,
    });
    expect(claimed).toBe(true);
    expect(await verify(payload(), requirements)).toEqual(feeRefusal);
    expect(await store.get(key)).toMatchObject({ state: "claimed" });
  });

  it("moves a nothing-sent record of the same payment to refused, and logs it", async () => {
    const { verify, store } = setup();
    const p = payload();
    const { fingerprintOf } = await import("../src/settlement/settle.js");
    await store.claim({
      key,
      network,
      payer,
      nonce: "7",
      fingerprint: fingerprintOf(p, requirements),
      paymentPayload: p,
      paymentRequirements: requirements,
      createdAt: 1_000,
    });
    await store.transition(key, "claimed", {
      state: "rejected",
      errorReason: SETTLE_REASONS.noChannels,
      updatedAt: 2_000,
    });
    lines.length = 0;
    await verify(p, requirements);
    expect(await store.get(key)).toMatchObject({ state: "refused", errorReason: FEE });
    expect(lines.join("")).toContain("settlement_refused_reopen");
  });

  it("records the payer's expiration ledger, so the pruner keeps the record until it closed", async () => {
    const { verify, store } = setup();
    await verify(payload(), requirements);
    expect(await store.pruneRefusals(1e12, { network, latest: EXPIRATION - 1 }, 10)).toBe(0);
    expect(await store.pruneRefusals(1e12, { network, latest: EXPIRATION }, 10)).toBe(1);
  });

  it("records nothing for an auth entry past the horizon, and says to wait for its ledger (0156)", async () => {
    const { verify, store } = setup(
      undefined,
      async () => EXPIRATION - REFUSAL_HORIZON_LEDGERS - 1,
    );
    lines.length = 0;
    expect(await verify(payload(), requirements)).toEqual({
      ...feeRefusal,
      invalidMessage:
        `this payment may still settle until ledger ${EXPIRATION}: sign a new payment once ` +
        `that ledger has closed; too high`,
      extra: { expirationLedger: EXPIRATION },
    });
    expect(await store.get(key)).toBeUndefined();
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "settlement_refusal_unrecorded",
        settlementKey: key,
        expirationLedger: EXPIRATION,
        ledgersLeft: REFUSAL_HORIZON_LEDGERS + 1,
      }),
    );
  });

  it("records an auth entry exactly at the horizon (0156)", async () => {
    const { verify, store } = setup(undefined, async () => EXPIRATION - REFUSAL_HORIZON_LEDGERS);
    expect((await verify(payload(), requirements)).invalidMessage).toBe(`${advice}; too high`);
    expect(await store.get(key)).toMatchObject({ state: "refused" });
  });

  it.each([
    ["fails", () => Promise.reject(new Error("down"))],
    ["is too slow", () => new Promise<never>(() => {})],
  ])("records the refusal when the ledger read %s, as before 0156", async (_, latestLedger) => {
    const { verify, store } = setup(undefined, latestLedger);
    lines.length = 0;
    expect((await verify(payload(), requirements)).invalidMessage).toBe(`${advice}; too high`);
    expect(await store.get(key)).toMatchObject({ state: "refused" });
    expect(lines.join("")).toContain("latest_ledger_failed");
  });

  it("says a settlement is under way when one of the same payment holds the key (#205)", async () => {
    const { verify, store } = setup();
    const p = payload();
    const { fingerprintOf } = await import("../src/settlement/settle.js");
    await store.claim({
      key,
      network,
      payer,
      nonce: "7",
      fingerprint: fingerprintOf(p, requirements),
      paymentPayload: p,
      paymentRequirements: requirements,
      createdAt: 1_000,
    });
    expect(await verify(p, requirements)).toEqual({
      ...feeRefusal,
      invalidMessage:
        "a settlement of this payment is under way: send this payment to /settle for its " +
        "outcome before signing a new one; too high",
    });
    expect(await store.get(key)).toMatchObject({ state: "claimed" });
  });

  it("answers from a record that holds the key without the horizon, adding no row (0156)", async () => {
    const latestLedger = vi.fn(async () => EXPIRATION - REFUSAL_HORIZON_LEDGERS - 1);
    const { verify, store } = setup(undefined, latestLedger);
    const p = payload();
    const { fingerprintOf } = await import("../src/settlement/settle.js");
    await store.claim({
      key,
      network,
      payer,
      nonce: "7",
      fingerprint: fingerprintOf(p, requirements),
      paymentPayload: p,
      paymentRequirements: requirements,
      createdAt: 1_000,
    });
    expect((await verify(p, requirements)).invalidMessage).toMatch(
      /^a settlement of this payment is under way/,
    );
    expect(latestLedger).not.toHaveBeenCalled();
    expect(await store.get(key)).toMatchObject({ state: "claimed" });
  });

  it.each([
    ["fails", { get: () => Promise.reject(new Error("down")) }],
    ["is too slow", { get: () => new Promise<never>(() => {}) }],
  ])("runs the checks when the store's lookup %s, as before 0086 (#205)", async (_, broken) => {
    const real = db.stores().settlements;
    const { inner, verify } = setup(Object.assign(Object.create(real) as typeof real, broken));
    inner.mockResolvedValueOnce({ isValid: true, payer });
    lines.length = 0;
    expect(await verify(payload(), requirements)).toEqual({ isValid: true, payer });
    expect(lines.join("")).toContain("verify_store_lookup_failed");
    // A refusal is still recorded.
    expect((await verify(payload(), requirements)).invalidMessage).toBe(`${advice}; too high`);
    expect(await real.get(key)).toMatchObject({ state: "refused" });
  });

  it.each([
    ["fails", { refuse: () => Promise.reject(new Error("down")) }],
    ["is too slow", { refuse: () => new Promise<never>(() => {}) }],
  ])("throws StoreUnavailableError when recording the refusal %s", async (_, broken) => {
    const real = db.stores().settlements;
    const { verify } = setup(Object.assign(Object.create(real) as typeof real, broken));
    await expect(verify(payload(), requirements)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});
