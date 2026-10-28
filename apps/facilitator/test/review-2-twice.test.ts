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

const landedTx = {
  status: rpc.Api.GetTransactionStatus.SUCCESS,
  ledger: 1001,
  resultXdr: { feeCharged: () => ({ toBigInt: () => 41_000n }) },
} as unknown as rpc.Api.GetTransactionResponse;

describe("REFUTE B: one process answers a success twice (finding 3 by another timing)", () => {
  it("B1: the success write hangs and then throws; meanwhile a sweep lands it and a repeat is answered success; then the fallback answers success too", async () => {
    const store = db.stores().settlements;
    const hooks = {
      onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
      onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
    };
    const logger = jsonLogger("error", () => {});
    const metrics = memoryMetrics();
    const records = createRecords({ network, store, hooks, logger, metrics });
    const { settle } = setup(landing(), { store, records });
    const reconciler = createReconciler({
      network,
      store,
      rpc: { getTransaction: async () => landedTx },
      records,
      logger,
      metrics,
      budgetMs: 5_000,
    });
    // The settler's success write goes out on a connection that dies: no reply for a while
    // (pg's query_timeout is 15 s), then an error. Other connections work.
    const transition = store.transition.bind(store);
    let hang: (() => void) | undefined;
    vi.spyOn(store, "transition").mockImplementation(async (k, from, update, version) => {
      if (update.state !== "success" || hang) return transition(k, from, update, version);
      await new Promise<void>((resolve) => (hang = resolve));
      throw new Error("Query read timeout");
    });
    const first = settle(payload(), requirements);
    await vi.waitFor(() => expect(hang).toBeDefined());
    expect(await reconciler.sweep()).toMatchObject({ success: 1 });
    // The resource server's repeat (e.g. after its own timeout) reaches this process.
    const repeat = (await settle(payload(), requirements)).response;
    hang!();
    const original = (await first).response;
    expect([repeat, original].filter((r) => r.success)).toHaveLength(1);
  });

  it("B2: no sweep needed: the success write commits but its reply is lost for a while; a repeat marks and gets success; then the fallback answers success too", async () => {
    const store = db.stores().settlements;
    const hooks = {
      onFinal: vi.fn<SettlementHooks["onFinal"]>(async () => {}),
      onSuccess: vi.fn<SettlementHooks["onSuccess"]>(async () => {}),
    };
    const logger = jsonLogger("error", () => {});
    const metrics = memoryMetrics();
    const records = createRecords({ network, store, hooks, logger, metrics });
    const { settle } = setup(landing(), { store, records });
    const transition = store.transition.bind(store);
    let hang: (() => void) | undefined;
    vi.spyOn(store, "transition").mockImplementation(async (k, from, update, version) => {
      if (update.state !== "success" || hang) return transition(k, from, update, version);
      await transition(k, from, update, version); // COMMIT reached the database
      await new Promise<void>((resolve) => (hang = resolve)); // the reply never arrives
      throw new Error("Query read timeout");
    });
    const first = settle(payload(), requirements);
    await vi.waitFor(() => expect(hang).toBeDefined());
    const repeat = (await settle(payload(), requirements)).response;
    hang!();
    const original = (await first).response;
    expect([repeat, original].filter((r) => r.success)).toHaveLength(1);
  });

  it("B3 (pre-existing since 0009): a repeat reads a record already marked answered, its own mark fails on a blip, and it answers success again", async () => {
    const { settle, store } = setup(landing());
    expect((await settle(payload(), requirements)).response.success).toBe(true);
    expect((await store.get(key))?.successAnsweredAt).toEqual(expect.any(Number));
    vi.spyOn(store, "markSuccessAnswered").mockRejectedValueOnce(new Error("connection reset"));
    const repeat = (await settle(payload(), requirements)).response;
    // The record it read already says the success was answered.
    expect(repeat).toEqual(alreadySettled);
  });
});
