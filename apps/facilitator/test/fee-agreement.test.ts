import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Account,
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
import { buildVerifier } from "../src/main.js";
import { feeSettings } from "../src/settlement/fees.js";
import type { VerifyTrace } from "../src/settlement/verify.js";

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

function payload(): PaymentPayload {
  const transaction = new TransactionBuilder(new Account(payer, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(transfer())
    .setTimeout(60)
    .build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: transaction.toXDR() } };
}

/** The pool's RPC: one channel, a ledger per call, and the same simulation. */
const poolRpc = {
  getAccount: async (address: string) => new Account(address, "1000"),
  getLatestLedger: async () =>
    ({ sequence: ++latestLedger }) as unknown as rpc.Api.GetLatestLedgerResponse,
  simulateTransaction: async () => rpc.parseRawSimulation(simulation()),
} as unknown as SorobanRpc;

describe("the fee ceiling at /verify and in the pool (AD-10)", () => {
  const config = parseConfig({
    FACILITATOR_SECRET: facilitator.secret(),
    CHANNELS: channel,
    RPC_URLS: "http://127.0.0.1:1",
    MAX_FEE_STROOPS: String(MAX_FEE),
    INCLUSION_FEE_STROOPS: String(BID),
  });
  // One fee configuration for both, as `main()` builds it.
  const fees = feeSettings(config.fees, poolRpc);

  /** Real upstream `ExactStellarScheme`, as `main()` wires it: did it refuse the fee? */
  async function verifyRefuses(): Promise<boolean> {
    const verify = buildVerifier({ ...config, rpcUrls: [rpcUrl] }, poolRpc, fees, {
      warn() {},
      info() {},
    });
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
  it("answers from the second URL and logs the switch", async () => {
    const config = parseConfig({
      FACILITATOR_SECRET: facilitator.secret(),
      CHANNELS: channel,
      // Nothing listens on port 1: upstream's simulation gets a refused connection.
      RPC_URLS: `http://127.0.0.1:1,${rpcUrl}`,
      MAX_FEE_STROOPS: String(MAX_FEE),
      INCLUSION_FEE_STROOPS: String(BID),
    });
    resourceFee = 100_000;
    const rpc = (i: number) => rpcEndpointName(config.rpcUrls[i]!, i);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const verify = buildVerifier(config, poolRpc, feeSettings(config.fees, poolRpc), logger);
    const trace: VerifyTrace = {};
    // The second URL's verdict: the fee passes, and the empty simulation has no transfer events.
    await expect(verify(payload(), requirements, trace)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_no_transfer_events",
    });
    expect(trace).toEqual({ rpc: rpc(1) });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("rpc_failover", {
      component: "verify",
      network: "stellar:testnet",
      from: rpc(0),
      to: rpc(1),
      reason: "unexpected_verify_error",
    });
  });
});
