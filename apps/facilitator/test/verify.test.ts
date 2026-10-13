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
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_ACCOUNT_REASON,
  MUXED_FACILITATOR_REASON,
  createVerifier,
  type UpstreamVerifier,
} from "../src/settlement/verify.js";

const network = STELLAR_NETWORKS.testnet;
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const channel = Keypair.random().publicKey();
const otherChannel = Keypair.random().publicKey();
const facilitator = Keypair.random().publicKey();
const CURRENT = 1_000;
const MIN_VALIDITY = 12;

const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

function authEntry(address: string, expiration: number, credentialType = "address") {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(address).toScAddress(),
    nonce: xdr.Int64.fromString("1"),
    signatureExpirationLedger: expiration,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      credentialType === "addressV2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
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

interface Shape {
  txSource?: Account | MuxedAccount;
  opSource?: string;
  from?: string;
  auth?: xdr.SorobanAuthorizationEntry[];
}

/** An `exact` payload: a `transfer` from the payer, signed for `CURRENT + MIN_VALIDITY`. */
function payload(shape: Shape = {}): PaymentPayload {
  const from = shape.from ?? payer;
  const transaction = new TransactionBuilder(shape.txSource ?? new Account(payer, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: asset,
        function: "transfer",
        args: [
          nativeToScVal(from, { type: "address" }),
          nativeToScVal(payTo, { type: "address" }),
          nativeToScVal(1000n, { type: "i128" }),
        ],
        auth: shape.auth ?? [authEntry(from, CURRENT + MIN_VALIDITY)],
        source: shape.opSource,
      }),
    )
    .setTimeout(60)
    .build();
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: transaction.toXDR() },
  };
}

function setup(upstreamResponse: VerifyResponse = { isValid: true, payer }) {
  const upstream = { verify: vi.fn<UpstreamVerifier["verify"]>(async () => upstreamResponse) };
  const latestLedger = vi.fn(async () => CURRENT);
  const verify = createVerifier({
    network,
    upstream,
    facilitator,
    channels: [channel, otherChannel],
    minValidityLedgers: MIN_VALIDITY,
    latestLedger,
  });
  return { verify, upstream, latestLedger };
}

const rejected = (invalidReason: string) =>
  expect.objectContaining({ isValid: false, invalidReason, payer });

describe("createVerifier", () => {
  it("returns upstream's valid answer when no channel appears and the auth lasts long enough", async () => {
    const { verify, upstream } = setup();
    const p = payload();
    await expect(verify(p, requirements)).resolves.toEqual({ isValid: true, payer });
    expect(upstream.verify).toHaveBeenCalledWith(p, requirements);
  });

  it("returns upstream's rejection as is, without the checks of its own", async () => {
    const answer = { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" };
    const { verify, latestLedger } = setup(answer);
    await expect(verify(payload({ from: channel }), requirements)).resolves.toBe(answer);
    expect(latestLedger).not.toHaveBeenCalled();
  });

  it("rejects another network before upstream sees it", async () => {
    const { verify, upstream } = setup();
    const pubnet = { ...requirements, network: STELLAR_NETWORKS.pubnet };
    await expect(verify(payload(), pubnet)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_network",
    });
    expect(upstream.verify).not.toHaveBeenCalled();
  });

  describe("channel accounts (AD-5)", () => {
    // Upstream's code for the same problem with the facilitator's address, and ours in `extra`.
    const channelRejected = (invalidReason: string) =>
      expect.objectContaining({
        isValid: false,
        invalidReason,
        payer,
        extra: { reason: CHANNEL_ACCOUNT_REASON },
      });
    const unsafeSource = channelRejected("invalid_exact_stellar_payload_unsafe_tx_or_op_source");

    it("rejects a channel as the transaction source", async () => {
      const { verify } = setup();
      const p = payload({ txSource: new Account(otherChannel, "1") });
      await expect(verify(p, requirements)).resolves.toEqual(unsafeSource);
    });

    it("rejects a muxed channel as the transaction source", async () => {
      const { verify } = setup();
      const muxed = new MuxedAccount(new Account(channel, "1"), "42");
      expect(muxed.accountId()).toMatch(/^M/);
      await expect(verify(payload({ txSource: muxed }), requirements)).resolves.toEqual(
        unsafeSource,
      );
    });

    it("rejects a channel as the operation source", async () => {
      const { verify } = setup();
      await expect(verify(payload({ opSource: channel }), requirements)).resolves.toEqual(
        unsafeSource,
      );
    });

    it("rejects a channel as `from`", async () => {
      const { verify } = setup();
      const p = payload({ from: channel, auth: [authEntry(payer, CURRENT + MIN_VALIDITY)] });
      await expect(verify(p, requirements)).resolves.toEqual(
        channelRejected("invalid_exact_stellar_payload_facilitator_is_payer"),
      );
    });

    it.each(["address", "addressV2"])(
      "rejects a channel as the address of an auth entry with %s credentials",
      async (credentialType) => {
        const { verify } = setup();
        const auth = [
          authEntry(payer, CURRENT + MIN_VALIDITY),
          authEntry(channel, CURRENT + MIN_VALIDITY, credentialType),
        ];
        await expect(verify(payload({ auth }), requirements)).resolves.toEqual(
          channelRejected("invalid_exact_stellar_payload_facilitator_in_auth"),
        );
      },
    );
  });

  describe("the facilitator's muxed address", () => {
    // Upstream rejects the plain address; a muxed one differs as a string and gets past it.
    const muxed = new MuxedAccount(new Account(facilitator, "1"), "7");
    const facilitatorRejected = (invalidReason: string) =>
      expect.objectContaining({
        isValid: false,
        invalidReason,
        payer,
        extra: { reason: MUXED_FACILITATOR_REASON },
      });

    it("rejects it as the transaction source", async () => {
      const { verify } = setup();
      await expect(verify(payload({ txSource: muxed }), requirements)).resolves.toEqual(
        facilitatorRejected("invalid_exact_stellar_payload_unsafe_tx_or_op_source"),
      );
    });

    it("rejects it as the operation source", async () => {
      const { verify } = setup();
      await expect(verify(payload({ opSource: muxed.accountId() }), requirements)).resolves.toEqual(
        facilitatorRejected("invalid_exact_stellar_payload_unsafe_tx_or_op_source"),
      );
    });

    it("rejects it as `from`", async () => {
      const { verify } = setup();
      const p = payload({
        from: muxed.accountId(),
        auth: [authEntry(payer, CURRENT + MIN_VALIDITY)],
      });
      await expect(verify(p, requirements)).resolves.toEqual(
        facilitatorRejected("invalid_exact_stellar_payload_facilitator_is_payer"),
      );
    });

    it("rejects it as the address of an auth entry", async () => {
      const { verify } = setup();
      const auth = [
        authEntry(payer, CURRENT + MIN_VALIDITY),
        authEntry(muxed.accountId(), CURRENT + MIN_VALIDITY),
      ];
      await expect(verify(payload({ auth }), requirements)).resolves.toEqual(
        facilitatorRejected("invalid_exact_stellar_payload_facilitator_in_auth"),
      );
    });
  });

  describe("remaining validity (AD-22)", () => {
    it.each(["address", "addressV2"])(
      "accepts auth exactly minValidityLedgers ahead and rejects one ledger less, with %s credentials",
      async (credentialType) => {
        const { verify } = setup();
        const at = (expiration: number) =>
          verify(payload({ auth: [authEntry(payer, expiration, credentialType)] }), requirements);
        await expect(at(CURRENT + MIN_VALIDITY)).resolves.toEqual({ isValid: true, payer });
        await expect(at(CURRENT + MIN_VALIDITY - 1)).resolves.toEqual(
          rejected("invalid_exact_stellar_signature_expiration_too_soon"),
        );
      },
    );

    it("counts the earliest expiring auth entry", async () => {
      const { verify } = setup();
      const auth = [
        authEntry(payer, CURRENT + 100),
        authEntry(Keypair.random().publicKey(), CURRENT + 5),
      ];
      const answer = await verify(payload({ auth }), requirements);
      expect(answer).toEqual(rejected("invalid_exact_stellar_signature_expiration_too_soon"));
      expect(answer.invalidMessage).toBe(
        "auth expires at ledger 1005, 5 ledgers after ledger 1000; at least 12 are required",
      );
    });

    it("throws when the current ledger can't be read", async () => {
      const { verify, latestLedger } = setup();
      latestLedger.mockRejectedValueOnce(new Error("rpc down"));
      await expect(verify(payload(), requirements)).rejects.toThrow("rpc down");
    });
  });
});
