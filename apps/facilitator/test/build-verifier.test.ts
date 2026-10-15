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
import { buildChecks, buildVerifier, settleCheck, type SchemeOptions } from "../src/main.js";
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

/** `answer` may depend on the scheme's RPC URL. */
function setup(
  answer: VerifyResponse | ((url: string) => VerifyResponse | Promise<VerifyResponse>) = {
    isValid: true,
    payer,
  },
) {
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
    const url = options.rpcConfig!.url!;
    return {
      verify: async () => (typeof answer === "function" ? answer(url) : answer),
    } satisfies UpstreamVerifier;
  });
  const logger = { warn: vi.fn() };
  const fees = feeSettings(config.fees, rpc);
  return {
    verify: buildVerifier(config, rpc, fees, logger, makeScheme),
    check: settleCheck(buildChecks(config, rpc, fees, logger, makeScheme)),
    schemes,
    logger,
  };
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

  it("answers from the second RPC URL while the first is down, and logs the switch", async () => {
    const { verify, schemes, logger } = setup((url) =>
      url === "https://rpc-a.example"
        ? { isValid: false, invalidReason: "unexpected_verify_error" }
        : { isValid: true, payer },
    );
    await expect(verify(payload(), requirements)).resolves.toEqual({ isValid: true, payer });
    expect(schemes.map(({ options }) => options.rpcConfig?.url)).toEqual([
      "https://rpc-a.example",
      "https://rpc-b.example",
    ]);
    // Names, not URLs: an RPC URL can carry an API key.
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("rpc_failover", {
      from: "RPC_URLS[0]",
      to: "RPC_URLS[1]",
    });
  });

  it("gives each RPC URL its own 10 s deadline, so a slow second URL still answers", async () => {
    vi.useFakeTimers();
    try {
      const { verify } = setup((url) =>
        url === "https://rpc-a.example"
          ? new Promise<never>(() => {})
          : new Promise((resolve) => setTimeout(() => resolve({ isValid: true, payer }), 5_000)),
      );
      const answer = verify(payload(), requirements);
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(answer).resolves.toEqual({ isValid: true, payer });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when upstream reports unexpected_verify_error on every RPC URL", async () => {
    const { verify } = setup({ isValid: false, invalidReason: "unexpected_verify_error", payer });
    await expect(verify(payload(), requirements)).rejects.toThrow("unexpected_verify_error");
  });

  it("rechecks /settle's auth expiry at the pool's floor of 2, not MIN_VALIDITY_LEDGERS", async () => {
    const { verify, check } = setup();
    // 3 ledgers left: below `/verify`'s default of 4, above the pool's 2.
    await expect(verify(payload(undefined, CURRENT + 3), requirements)).resolves.toMatchObject({
      isValid: false,
    });
    const at = async (expiration: number) =>
      (await check(payload(undefined, expiration), requirements)).response;
    await expect(at(CURRENT + 3)).resolves.toEqual({ isValid: true, payer });
    await expect(at(CURRENT + 2)).resolves.toEqual({ isValid: true, payer });
    await expect(at(CURRENT + 1)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_signature_expiration_too_soon",
    });
  });
});
