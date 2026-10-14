import {
  Account,
  Address,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { buildVerifier, type SchemeOptions } from "../src/main.js";
import { feeSettings } from "../src/settlement/fees.js";
import {
  CHANNEL_ACCOUNT_REASON,
  MUXED_FACILITATOR_REASON,
  type UpstreamVerifier,
} from "../src/settlement/verify.js";

const secret = Keypair.random().secret();
const channel = Keypair.random().publicKey();
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const CURRENT = 1_000;

const config = parseConfig({
  FACILITATOR_SECRET: secret,
  CHANNELS: channel,
  RPC_URLS: "https://rpc-a.example,https://rpc-b.example",
  MAX_FEE_STROOPS: "300000",
});

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: config.network,
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

/** A `transfer` from the payer, with auth to `expiration` and `source` as the transaction source. */
function payload(
  source: Account | MuxedAccount = new Account(payer, "1"),
  expiration = CURRENT + 12,
): PaymentPayload {
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(payer).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: expiration,
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
  const transaction = new TransactionBuilder(source, {
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
    .setTimeout(60)
    .build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: transaction.toXDR() } };
}

function setup(answer: VerifyResponse = { isValid: true, payer }) {
  const rpc = {
    getFeeStats: vi.fn(
      async () =>
        ({ sorobanInclusionFee: { p90: "250" } }) as unknown as Awaited<
          ReturnType<SorobanRpc["getFeeStats"]>
        >,
    ),
    getLatestLedger: vi.fn(
      async () =>
        ({ sequence: CURRENT }) as unknown as Awaited<ReturnType<SorobanRpc["getLatestLedger"]>>,
    ),
  };
  const schemes: { signer: string; options: SchemeOptions }[] = [];
  const makeScheme = vi.fn((signer: { address: string }, options: SchemeOptions) => {
    schemes.push({ signer: signer.address, options });
    return { verify: async () => answer } satisfies UpstreamVerifier;
  });
  return { verify: buildVerifier(config, rpc, feeSettings(config.fees, rpc), makeScheme), schemes };
}

describe("buildVerifier (the /verify wiring in main)", () => {
  it("gives upstream the facilitator key, the first RPC URL, the ceiling and twice the shared bid", async () => {
    const { verify, schemes } = setup();
    await expect(verify(payload(), requirements)).resolves.toEqual({ isValid: true, payer });
    expect(schemes).toEqual([
      {
        signer: Keypair.fromSecret(secret).publicKey(),
        options: {
          rpcConfig: { url: "https://rpc-a.example" },
          maxTransactionFeeStroops: 300_000,
          // The fee-stats bid (250), paid by the inner operation and the fee bump.
          inclusionFeeStroops: 500,
        },
      },
    ]);
  });

  it("rejects a configured channel through the built verifier", async () => {
    const { verify } = setup();
    await expect(verify(payload(new Account(channel, "1")), requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
      extra: { reason: CHANNEL_ACCOUNT_REASON },
    });
  });

  it("rejects the facilitator's muxed address, which upstream's plain-string check misses", async () => {
    const { verify } = setup();
    const muxed = new MuxedAccount(new Account(Keypair.fromSecret(secret).publicKey(), "1"), "7");
    await expect(verify(payload(muxed), requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
      extra: { reason: MUXED_FACILITATOR_REASON },
    });
  });

  it("checks the auth expiry against the latest ledger and MIN_VALIDITY_LEDGERS (default 4)", async () => {
    const { verify } = setup();
    await expect(verify(payload(undefined, CURRENT + 4), requirements)).resolves.toEqual({
      isValid: true,
      payer,
    });
    await expect(verify(payload(undefined, CURRENT + 3), requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_signature_expiration_too_soon",
    });
  });

  it("throws when upstream reports unexpected_verify_error", async () => {
    const { verify } = setup({ isValid: false, invalidReason: "unexpected_verify_error", payer });
    await expect(verify(payload(), requirements)).rejects.toThrow("unexpected_verify_error");
  });
});
