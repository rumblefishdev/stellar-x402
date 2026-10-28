import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  FeeLimitError,
  SettlementSubmitter,
  SignedHookError,
  keypairSigner,
  type SorobanRpc,
} from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { rpcEndpointName } from "../src/logger.js";
import { buildChecks, buildRpc, buildVerifier, settleCheck } from "../src/main.js";
import { feeSettings } from "../src/settlement/fees.js";
import { createVerifier, type VerifyTrace } from "../src/settlement/verify.js";

const MAX_FEE = 250_000;
const BID = 1_000;
const facilitator = Keypair.random();
const channel = Keypair.random().publicKey();
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();

/** The resource fee every simulation reports, upstream's and the pool's alike. */
let resourceFee = 0;
let latestLedger = 100;

function simulation() {
  return {
    id: "1",
    latestLedger,
    minResourceFee: String(resourceFee),
    transactionData: new SorobanDataBuilder().setResourceFee(resourceFee).build().toXDR("base64"),
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
    events: [],
  } satisfies rpc.Api.RawSimulateTransactionResponse;
}

/**
 * Answers upstream's `simulateTransaction`; upstream makes no other RPC call before its fee check.
 */
let server: Server;
let rpcUrl: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          method === "simulateTransaction"
            ? { jsonrpc: "2.0", id, result: simulation() }
            : { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } },
        ),
      );
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

const transfer = () =>
  Operation.invokeContractFunction({
    contract: asset,
    function: "transfer",
    args: [
      nativeToScVal(payer, { type: "address" }),
      nativeToScVal(payTo, { type: "address" }),
      nativeToScVal(1000n, { type: "i128" }),
    ],
    auth: [],
  });

/** The payment as the buyer's client sends it, with the Soroban data its own simulation gave. */
function payload(sorobanData?: xdr.SorobanTransactionData): PaymentPayload {
  const builder = new TransactionBuilder(new Account(payer, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(transfer())
    .setTimeout(60);
  if (sorobanData) builder.setSorobanData(sorobanData);
  const transaction = builder.build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: transaction.toXDR() } };
}

/** The pool's RPC: one channel, a ledger per call, and the same simulation. */
const poolRpc = {
  getLedgerEntries: async () => ({
    entries: [{ val: { account: () => ({ seqNum: () => xdr.Int64.fromString("1000") }) } }],
  }),
  getLatestLedger: async () =>
    ({ sequence: ++latestLedger }) as unknown as rpc.Api.GetLatestLedgerResponse,
  simulateTransaction: async () => rpc.parseRawSimulation(simulation()),
} as unknown as SorobanRpc;

describe("the fee ceiling at /verify and in the pool (AD-10)", () => {
  const config = parseConfig({
    FACILITATOR_SECRET: facilitator.secret(),
    DATABASE_URL: "postgres://db.internal/x402",
    CLIENT_IP: "socket",
    CHANNELS: channel,
    RPC_URLS: "http://127.0.0.1:1",
    MAX_FEE_STROOPS: String(MAX_FEE),
    INCLUSION_FEE_STROOPS: String(BID),
  });
  // One fee configuration for both, as `main()` builds it.
  const fees = feeSettings(config.fees, poolRpc);

  /** Real upstream `ExactStellarScheme`, as `main()` wires it: did it refuse the fee? */
  async function verifyRefuses(): Promise<boolean> {
    const cfg = { ...config, rpcUrls: [rpcUrl] };
    const logger = { warn() {}, info() {} };
    const verify = buildVerifier(
      cfg,
      buildRpc(cfg, logger, () => poolRpc),
      fees,
      logger,
    );
    const answer = await verify(payload(), requirements);
    // A fee it accepts goes on to the event check, which an empty simulation fails.
    expect(answer.invalidReason).toMatch(/fee_exceeds_maximum|no_transfer_events/);
    return answer.invalidReason === "invalid_exact_stellar_payload_fee_exceeds_maximum";
  }

  /** The pool from the same fee settings: did it refuse the fee before signing? */
  async function poolRefuses(): Promise<boolean> {
    const submitter = new SettlementSubmitter({
      rpc: poolRpc,
      networkPassphrase: Networks.TESTNET,
      signer: keypairSigner(facilitator),
      channels: [channel],
      ...fees.pool,
      sleep: async () => {},
    });
    const op = transfer();
    const call = {
      func: (op.body().value() as xdr.InvokeHostFunctionOp).hostFunction(),
      auth: [],
    };
    // A fee it accepts is signed; refusing the signed hash stops it before anything is sent.
    const error = await submitter
      .submit(call, {
        onSigned: () => {
          throw new Error("stop before sending");
        },
      })
      .catch((e: unknown) => e);
    expect(error).toSatisfy((e) => e instanceof FeeLimitError || e instanceof SignedHookError);
    return error instanceof FeeLimitError;
  }

  it.each([
    ["well below", 100_000, false],
    ["exactly at the ceiling with twice the bid", MAX_FEE - 2 * BID, false],
    ["one stroop above the ceiling with twice the bid", MAX_FEE - 2 * BID + 1, true],
    // Upstream alone (resource + one bid) accepted this; the pool always refused it.
    ["at the ceiling with one bid", MAX_FEE - BID, true],
  ])("agrees on a resource fee %s (%i stroops)", async (_name, fee, refused) => {
    resourceFee = fee;
    expect(await verifyRefuses()).toBe(refused);
    expect(await poolRefuses()).toBe(refused);
  });
});

describe("real upstream with a down first RPC URL (AD-3)", () => {
  it("answers from the second URL, and leaves the shared client on the first (decision 22)", async () => {
    const config = parseConfig({
      FACILITATOR_SECRET: facilitator.secret(),
      DATABASE_URL: "postgres://db.internal/x402",
      CLIENT_IP: "socket",
      CHANNELS: channel,
      // Nothing listens on port 1: upstream's simulation gets a refused connection.
      RPC_URLS: `http://127.0.0.1:1,${rpcUrl}`,
      MAX_FEE_STROOPS: String(MAX_FEE),
      INCLUSION_FEE_STROOPS: String(BID),
    });
    resourceFee = 100_000;
    const rpc = (i: number) => rpcEndpointName(config.rpcUrls[i]!, i);
    const logger = { warn: vi.fn(), info: vi.fn() };
    // The pool's reads still work on both URLs: only upstream's simulation is refused.
    const shared = buildRpc(config, logger, () => poolRpc);
    const verify = buildVerifier(config, shared, feeSettings(config.fees, shared), logger);
    const trace: VerifyTrace = {};
    // The second URL's verdict: the fee passes, and the empty simulation has no transfer events.
    await expect(verify(payload(), requirements, trace)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_no_transfer_events",
    });
    expect(trace).toEqual({ rpc: rpc(1) });
    // Upstream answers a refused connection with unexpected_verify_error, which moves nothing.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(shared.active).toBe(rpc(0));
  });
});

/** A persistent contract-data key of `asset`. */
const dataKey = (key: xdr.ScVal) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(asset).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
const instanceKey = dataKey(xdr.ScVal.scvLedgerKeyContractInstance());
const payerBalanceKey = dataKey(
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(payer).toScVal()]),
);

/**
 * Soroban data whose read-write footprint is `readWrite`, of which the entries at `archived` are
 * archived: what a Protocol 23 simulation reports, and what the buyer's client puts in the payment.
 */
function restoringData(
  readWrite: xdr.LedgerKey[],
  archived: number[],
  readOnly: xdr.LedgerKey[] = [],
) {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(
      1,
      new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archived }),
    ),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly, readWrite }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString(String(resourceFee)),
  });
}

describe("a fee refusal for a payment that restores archived state (task 0066)", () => {
  // The buyer's client builds the payment with `assembleTransaction` from its own simulation, so
  // the archived entries reach us in the payment itself.
  it("keeps the simulation's archived entries in the client's assembled transaction", () => {
    resourceFee = 300_000;
    const raw = new TransactionBuilder(new Account(payer, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(transfer())
      .setTimeout(60)
      .build();
    const sim = rpc.parseRawSimulation({
      ...simulation(),
      transactionData: restoringData([instanceKey, payerBalanceKey], [1]).toXDR("base64"),
    });
    const ext = rpc
      .assembleTransaction(raw, sim)
      .build()
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData()
      .ext();
    expect(ext.switch()).toBe(1);
    expect((ext.value() as xdr.SorobanResourcesExtV0).archivedSorobanEntries()).toEqual([1]);
  });

  /** The checks `main()` builds for `/verify` and `/settle`, simulating `fee` stroops. */
  function checksAt(fee: number) {
    const config = parseConfig({
      FACILITATOR_SECRET: facilitator.secret(),
      DATABASE_URL: "postgres://db.internal/x402",
      CLIENT_IP: "socket",
      CHANNELS: channel,
      RPC_URLS: rpcUrl,
      MAX_FEE_STROOPS: String(MAX_FEE),
      INCLUSION_FEE_STROOPS: String(BID),
    });
    resourceFee = fee;
    const logger = { warn() {}, info() {} };
    const shared = buildRpc(config, logger, () => poolRpc);
    return buildChecks(config, shared, feeSettings(config.fees, shared), logger);
  }

  /** Real upstream as `main()` wires it for `/verify`, simulating `fee` stroops. */
  const verifyAt = (fee: number) => createVerifier(checksAt(fee));

  it("keeps upstream's code and names the archived entries in its message", async () => {
    const verify = verifyAt(300_000);
    const answer = await verify(
      payload(restoringData([instanceKey, payerBalanceKey], [0, 1])),
      requirements,
    );
    expect(answer).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_fee_exceeds_maximum",
      invalidMessage:
        "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops; " +
        "the payment's transaction lists 2 archived entries to restore: " +
        `${instanceKey.toXDR("base64")}, ${payerBalanceKey.toXDR("base64")}`,
    });
  });

  it("names at most four archived entries", async () => {
    const keys = [1, 2, 3, 4, 5, 6].map((i) => dataKey(xdr.ScVal.scvU32(i)));
    const answer = await verifyAt(300_000)(
      payload(restoringData(keys, [0, 1, 2, 3, 4, 5])),
      requirements,
    );
    expect(answer.invalidMessage).toBe(
      "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops; " +
        "the payment's transaction lists 6 archived entries to restore: " +
        `${keys
          .slice(0, 4)
          .map((key) => key.toXDR("base64"))
          .join(", ")}, and 2 more`,
    );
  });

  it("names the read-write entries the indexes point to, not the read-only ones", async () => {
    // A transfer's footprint: the token's code and instance read-only, the two balances written.
    const codeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 7) }),
    );
    const payToBalanceKey = dataKey(
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(payTo).toScVal()]),
    );
    const answer = await verifyAt(300_000)(
      payload(restoringData([payerBalanceKey, payToBalanceKey], [0], [codeKey, instanceKey])),
      requirements,
    );
    expect(answer.invalidMessage).toBe(
      "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops; " +
        `the payment's transaction lists 1 archived entry to restore: ${payerBalanceKey.toXDR("base64")}`,
    );
  });

  it("names each entry once, and none an index outside the footprint points to", async () => {
    const answer = await verifyAt(300_000)(
      payload(restoringData([instanceKey, payerBalanceKey, instanceKey], [0, 0, 2, 1, 1, 9])),
      requirements,
    );
    expect(answer.invalidMessage).toBe(
      "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops; " +
        "the payment's transaction lists 2 archived entries to restore: " +
        `${instanceKey.toXDR("base64")}, ${payerBalanceKey.toXDR("base64")}`,
    );
  });

  it("names no entry that doesn't archive, or whose key is too long to name", async () => {
    const temporaryKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(asset).toScAddress(),
        key: xdr.ScVal.scvU32(1),
        durability: xdr.ContractDataDurability.temporary(),
      }),
    );
    const accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(payer).xdrAccountId() }),
    );
    const longKey = dataKey(xdr.ScVal.scvBytes(Buffer.alloc(400)));
    const answer = await verifyAt(300_000)(
      payload(restoringData([temporaryKey, accountKey, longKey, instanceKey], [0, 1, 2, 3])),
      requirements,
    );
    expect(answer.invalidMessage).toBe(
      "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops; " +
        `the payment's transaction lists 1 archived entry to restore: ${instanceKey.toXDR("base64")}`,
    );
  });

  it("leaves another refusal as upstream gave it", async () => {
    // Under the ceiling: upstream goes on to the event check, which the empty simulation fails.
    const answer = await verifyAt(100_000)(
      payload(restoringData([instanceKey, payerBalanceKey], [0, 1])),
      requirements,
    );
    expect(answer).toEqual({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_no_transfer_events",
      invalidMessage: undefined,
      payer,
    });
  });

  it.each([
    ["no Soroban data", undefined],
    ["no archived entries", restoringData([instanceKey, payerBalanceKey], [])],
  ])("leaves a fee refusal for a payment with %s as upstream gave it", async (_name, data) => {
    const answer = await verifyAt(300_000)(payload(data), requirements);
    expect(answer.invalidMessage).toBe(
      "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops",
    );
  });

  it("names them in /settle's check too, which passes the message on (the upfront flow)", async () => {
    const check = settleCheck(checksAt(300_000));
    const { response } = await check(payload(restoringData([instanceKey], [0])), requirements);
    expect(response.invalidMessage).toBe(
      "simulation-derived fee 302000 stroops exceeds ceiling 250000 stroops; " +
        `the payment's transaction lists 1 archived entry to restore: ${instanceKey.toXDR("base64")}`,
    );
  });
});
