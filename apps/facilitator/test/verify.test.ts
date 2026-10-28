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
  EXPIRATION_TOO_FAR_REASON,
  MUXED_FACILITATOR_REASON,
  PAYER_AUTH_REASON,
  UpstreamTimeoutError,
  createChecker,
  createVerifier,
  signedLedgers,
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
    // Differs from the requirements, so the tests see which one reaches upstream.
    accepted: { ...requirements, amount: "1" },
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
    const trace = {};
    await expect(verify(p, requirements, trace)).resolves.toEqual({ isValid: true, payer });
    // The trace goes to upstream, which names the RPC URL that answered.
    expect(upstream.verify).toHaveBeenCalledWith(p, requirements, trace);
  });

  it("throws upstream's unexpected_verify_error, which is a failure of ours, not a verdict", async () => {
    const { verify, latestLedger } = setup({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      payer,
    });
    await expect(verify(payload(), requirements)).rejects.toThrow(
      "upstream verify failed with unexpected_verify_error",
    );
    expect(latestLedger).not.toHaveBeenCalled();
  });

  it("returns upstream's rejection as is, without the checks of its own", async () => {
    const answer = { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" };
    const { verify, latestLedger } = setup(answer);
    await expect(verify(payload({ from: channel }), requirements)).resolves.toBe(answer);
    expect(latestLedger).not.toHaveBeenCalled();
  });

  it("passes upstream's payer on only when it is a string", async () => {
    // Upstream reads `payer` from `from` before any signature check; the client picks its type.
    for (const notString of [5, 5n]) {
      const { verify } = setup({
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_wrong_recipient",
        payer: notString as unknown as string,
      });
      await expect(verify(payload(), requirements)).resolves.toEqual({
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_wrong_recipient",
      });
    }
  });

  it("throws when upstream calls a payment valid without naming its payer", async () => {
    // `/settle` couldn't key such a payment, so `/verify` must not accept it.
    const { verify, latestLedger } = setup({ isValid: true });
    await expect(verify(payload(), requirements)).rejects.toThrow("upstream verify named no payer");
    expect(latestLedger).not.toHaveBeenCalled();
  });

  it("rejects a source-account auth entry, which would authorize as the facilitator, even if upstream accepts it", async () => {
    const sourceAccount = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: authEntry(payer, CURRENT + MIN_VALIDITY).rootInvocation(),
    });
    const { verify } = setup();
    await expect(
      verify(
        payload({ auth: [authEntry(payer, CURRENT + MIN_VALIDITY), sourceAccount] }),
        requirements,
      ),
    ).resolves.toEqual(rejected("invalid_exact_stellar_payload_unsupported_credential_type"));
  });

  it("throws when upstream gives no answer within upstreamTimeoutMs", async () => {
    const verify = createVerifier({
      network,
      upstream: { verify: () => new Promise<never>(() => {}) },
      facilitator,
      channels: [channel],
      minValidityLedgers: MIN_VALIDITY,
      latestLedger: async () => CURRENT,
      upstreamTimeoutMs: 20,
    });
    await expect(verify(payload(), requirements)).rejects.toThrow(UpstreamTimeoutError);
  });

  it("rejects a V0 envelope as malformed before upstream sees it", async () => {
    const { verify, upstream } = setup();
    const v1 = xdr.TransactionEnvelope.fromXDR(
      (payload().payload as { transaction: string }).transaction,
      "base64",
    )
      .v1()
      .tx();
    const v0 = xdr.TransactionEnvelope.envelopeTypeTxV0(
      new xdr.TransactionV0Envelope({
        tx: new xdr.TransactionV0({
          sourceAccountEd25519: v1.sourceAccount().ed25519(),
          fee: v1.fee(),
          seqNum: v1.seqNum(),
          timeBounds: v1.cond().timeBounds(),
          memo: v1.memo(),
          operations: v1.operations(),
          ext: new xdr.TransactionV0Ext(0),
        }),
        signatures: [],
      }),
    );
    const p = { ...payload(), payload: { transaction: v0.toXDR("base64") } };
    await expect(verify(p, requirements)).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_malformed",
    });
    expect(upstream.verify).not.toHaveBeenCalled();
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

  describe("the payer's auth entry (AD-6)", () => {
    // Upstream de-duplicates signers, so it accepts these; `/settle` can't key them.
    it.each([
      [
        "two auth entries for the payer",
        () => [authEntry(payer, CURRENT + MIN_VALIDITY), authEntry(payer, CURRENT + MIN_VALIDITY)],
      ],
      [
        "no auth entry for the payer",
        () => [authEntry(Keypair.random().publicKey(), CURRENT + MIN_VALIDITY)],
      ],
    ])("rejects %s, which /settle couldn't settle", async (_, auth) => {
      const { verify } = setup();
      await expect(verify(payload({ auth: auth() }), requirements)).resolves.toEqual(
        rejected(PAYER_AUTH_REASON),
      );
    });

    it("hands /settle the payer's nonce, its auth expiry and the ledger it read", async () => {
      const check = createChecker({
        network,
        upstream: { verify: async () => ({ isValid: true, payer }) },
        facilitator,
        channels: [channel],
        minValidityLedgers: MIN_VALIDITY,
        latestLedger: async () => CURRENT,
      });
      const { verified } = await check(payload(), requirements);
      expect(verified).toMatchObject({
        payer,
        nonce: "1",
        expirationLedger: CURRENT + MIN_VALIDITY,
        currentLedger: CURRENT,
      });
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

    it("rejects auth that expires past the last ledger the pool can bound an envelope by", async () => {
      // A huge maxTimeoutSeconds signs to 0xFFFFFFFF, which `submit()`'s `maxLedger` refuses.
      const { verify } = setup();
      const at = (expiration: number) =>
        verify(payload({ auth: [authEntry(payer, expiration)] }), requirements);
      await expect(at(2 ** 32 - 2)).resolves.toEqual({ isValid: true, payer });
      await expect(at(2 ** 32 - 1)).resolves.toEqual(rejected(EXPIRATION_TOO_FAR_REASON));
    });

    it("counts the earliest expiring auth entry", async () => {
      const { verify } = setup();
      const auth = [
        authEntry(payer, CURRENT + 100),
        authEntry(Keypair.random().publicKey(), CURRENT + 5),
      ];
      const answer = await verify(payload({ auth }), { ...requirements, maxTimeoutSeconds: 300 });
      expect(answer).toEqual(rejected("invalid_exact_stellar_signature_expiration_too_soon"));
      expect(answer.invalidMessage).toBe(
        "auth expires at ledger 1005, 5 ledgers after ledger 1000; at least 12 are required",
      );
    });

    it("says when the resource's maxTimeoutSeconds signs for about minValidityLedgers or fewer", async () => {
      expect([signedLedgers(20), signedLedgers(21), signedLedgers(60)]).toEqual([4, 5, 12]);
      const { verify } = setup();
      const auth = [authEntry(payer, CURRENT + 11)];
      for (const [maxTimeoutSeconds, hint] of [
        [60, "; maxTimeoutSeconds 60 is about 12 ledgers, so it should be well above 60"],
        [61, ""],
      ] as const) {
        const answer = await verify(payload({ auth }), { ...requirements, maxTimeoutSeconds });
        expect(answer.invalidMessage).toBe(
          `auth expires at ledger 1011, 11 ledgers after ledger 1000; at least 12 are required${hint}`,
        );
      }
    });

    it("throws when the current ledger can't be read", async () => {
      const { verify, latestLedger } = setup();
      latestLedger.mockRejectedValueOnce(new Error("rpc down"));
      await expect(verify(payload(), requirements)).rejects.toThrow("rpc down");
    });
  });
});
