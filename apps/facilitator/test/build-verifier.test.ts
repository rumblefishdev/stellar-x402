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
import { parseConfig, type Config } from "../src/config.js";
import { createEd25519Signer } from "@x402/stellar";
import {
  FAILBACK_MAX_LAG_LEDGERS,
  PRIMARY_PROBE_INTERVAL_MS,
  UPSTREAM_TIMEOUT_MS,
  buildChecks,
  buildRpc,
  buildUpstream,
  buildVerifier,
  settleCheck,
  upstreamDeadlineMs,
  type SchemeOptions,
} from "../src/main.js";
import { rpcEndpointName } from "../src/logger.js";
import { feeSettings, type FeeSettings } from "../src/settlement/fees.js";
import {
  CHANNEL_ACCOUNT_REASON,
  MUXED_FACILITATOR_REASON,
  UpstreamTimeoutError,
  type UpstreamVerifier,
  type VerifyTrace,
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
/** How the logs name `RPC_URLS[i]`. */
const rpc = (i: number) => rpcEndpointName(config.rpcUrls[i]!, i);

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

type FeeStats = Awaited<ReturnType<SorobanRpc["getFeeStats"]>>;

interface SetupOptions {
  /** Delays the fee-stats read. */
  feeStatsMs?: number;
  /** Overrides the fee settings, e.g. a bid that changes between calls. */
  fees?: (fees: FeeSettings) => FeeSettings;
  config?: Config;
  /** The latest ledger per RPC URL, for the AD-22 read and the probe. */
  latestLedger?: (url: string) => Promise<number>;
}

/** `answer` may depend on the scheme's RPC URL and get the call's arguments. */
function setup(
  answer:
    | VerifyResponse
    | ((
        url: string,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
      ) => VerifyResponse | Promise<VerifyResponse>) = {
    isValid: true,
    payer,
  },
  opts: SetupOptions = {},
) {
  const { feeStatsMs = 0, config: cfg = config } = opts;
  const stats = { sorobanInclusionFee: { p90: "250" } } as unknown as FeeStats;
  const latestLedger = vi.fn(opts.latestLedger ?? (async () => CURRENT));
  const logger = { warn: vi.fn(), info: vi.fn() };
  // The shared client over the same URLs, as `main()` builds it (AD-3).
  const rpc = buildRpc(
    cfg,
    logger,
    (url) =>
      ({
        getFeeStats: () =>
          feeStatsMs === 0
            ? Promise.resolve(stats)
            : new Promise<FeeStats>((resolve) => setTimeout(() => resolve(stats), feeStatsMs)),
        getLatestLedger: async () => ({ sequence: await latestLedger(url) }),
      }) as unknown as SorobanRpc,
  );
  const schemes: { signer: string; options: SchemeOptions }[] = [];
  const makeScheme = vi.fn((signer: { address: string }, options: SchemeOptions) => {
    schemes.push({ signer: signer.address, options });
    const url = options.rpcConfig!.url!;
    return {
      verify: async (p, r) => {
        if (typeof answer !== "function") return answer;
        return answer(url, p, r);
      },
    } satisfies UpstreamVerifier;
  });
  const base = feeSettings(cfg.fees, rpc);
  const fees = opts.fees ? opts.fees(base) : base;
  const seams = { makeScheme };
  return {
    verify: buildVerifier(cfg, rpc, fees, logger, seams),
    check: settleCheck(buildChecks(cfg, rpc, fees, logger, seams)),
    schemes,
    logger,
    latestLedger,
    rpc,
  };
}

/** The same config with a fixed bid. */
const fixedBid: Config = { ...config, fees: { ...config.fees, inclusionFeeStroops: 100n } };

const down = { isValid: false, invalidReason: "unexpected_verify_error" } as const;

describe("buildVerifier (the /verify wiring in main)", () => {
  it("gives each RPC URL's scheme the facilitator key, the ceiling and twice the shared bid", async () => {
    const { verify, schemes } = setup();
    const trace: VerifyTrace = {};
    await expect(verify(payload(), requirements, trace)).resolves.toEqual({ isValid: true, payer });
    expect(trace).toEqual({ rpc: rpc(0) });
    expect(schemes).toEqual(
      ["https://rpc-a.example", "https://rpc-b.example"].map((url) => ({
        signer: Keypair.fromSecret(secret).publicKey(),
        options: {
          rpcConfig: { url },
          maxTransactionFeeStroops: 300_000,
          // The fee-stats bid (250), paid by the inner operation and the fee bump.
          inclusionFeeStroops: 500,
        },
      })),
    );
    // Built once for the bid, not on every call.
    await verify(payload(), requirements);
    expect(schemes).toHaveLength(2);
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

  it("answers from the second RPC URL when the first throws, and moves the shared client there", async () => {
    const {
      verify,
      logger,
      rpc: shared,
    } = setup((url) => {
      if (url === "https://rpc-a.example") throw new Error("connect ECONNREFUSED");
      return { isValid: true, payer };
    });
    const trace: VerifyTrace = {};
    await expect(verify(payload(), requirements, trace)).resolves.toEqual({ isValid: true, payer });
    expect(trace).toEqual({ rpc: rpc(1) });
    // Names, not URLs: an RPC URL can carry an API key.
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("rpc_failover", {
      component: "rpc",
      network: config.network,
      by: "verify",
      from: rpc(0),
      to: rpc(1),
      reason: "error:Error",
    });
    // The AD-22 read and the pool start there too.
    expect(shared.active).toBe(rpc(1));
  });

  it("answers from the second RPC URL on unexpected_verify_error, without moving anything", async () => {
    const {
      verify,
      logger,
      rpc: shared,
    } = setup((url) => (url === "https://rpc-a.example" ? down : { isValid: true, payer }));
    const trace: VerifyTrace = {};
    await expect(verify(payload(), requirements, trace)).resolves.toEqual({ isValid: true, payer });
    expect(trace).toEqual({ rpc: rpc(1) });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(shared.active).toBe(rpc(0));
  });

  it("passes the payload and the requirements on to the scheme", async () => {
    const seen: [PaymentPayload, PaymentRequirements][] = [];
    const { verify } = setup((_url, p, r) => {
      seen.push([p, r]);
      return { isValid: true, payer };
    });
    const sent = payload();
    await verify(sent, requirements);
    expect(seen).toEqual([[sent, requirements]]);
    expect(seen[0]![0]).toBe(sent);
  });

  it("stays on the second RPC URL when the bid changes (decision 2)", async () => {
    let bid = 250;
    const called: string[] = [];
    const { verify, schemes, logger } = setup(
      (url) => {
        called.push(url);
        if (url === "https://rpc-a.example") throw new Error("connect ECONNREFUSED");
        return { isValid: true, payer };
      },
      { fees: (fees) => ({ ...fees, inclusionFee: async () => bid }) },
    );
    await verify(payload(), requirements);
    bid = 300;
    const trace: VerifyTrace = {};
    await verify(payload(), requirements, trace);
    expect(trace).toEqual({ rpc: rpc(1) });
    // The new bid's call starts on the active URL, not on RPC_URLS[0] again.
    expect(called).toEqual([
      "https://rpc-a.example",
      "https://rpc-b.example",
      "https://rpc-b.example",
    ]);
    expect(logger.warn).toHaveBeenCalledOnce();
    // Built again for the new bid: two URLs per bid.
    expect(schemes.map((s) => s.options.inclusionFeeStroops)).toEqual([500, 500, 600, 600]);
  });

  it("returns to the first RPC URL after a probe every PRIMARY_PROBE_INTERVAL_MS", async () => {
    vi.useFakeTimers();
    try {
      let firstDown = true;
      const { verify, logger } = setup((url) => {
        if (url === "https://rpc-a.example" && firstDown) throw new Error("connect ECONNREFUSED");
        return { isValid: true, payer };
      });
      await verify(payload(), requirements);
      firstDown = false;
      vi.advanceTimersByTime(PRIMARY_PROBE_INTERVAL_MS - 1);
      await verify(payload(), requirements);
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.info).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await verify(payload(), requirements);
      await vi.waitFor(() =>
        expect(logger.info).toHaveBeenCalledExactlyOnceWith("rpc_failback", {
          component: "rpc",
          network: config.network,
          from: rpc(1),
          to: rpc(0),
          lagLedgers: 0,
        }),
      );
      const trace: VerifyTrace = {};
      await verify(payload(), requirements, trace);
      expect(trace).toEqual({ rpc: rpc(0) });
    } finally {
      vi.useRealTimers();
    }
  });

  it(`stays off a first RPC URL more than ${FAILBACK_MAX_LAG_LEDGERS} ledgers behind`, async () => {
    vi.useFakeTimers();
    try {
      const { verify, logger } = setup(
        (url) => {
          if (url === "https://rpc-a.example") throw new Error("connect ECONNREFUSED");
          return { isValid: true, payer };
        },
        {
          latestLedger: async (url) =>
            url === "https://rpc-a.example" ? CURRENT - FAILBACK_MAX_LAG_LEDGERS - 1 : CURRENT,
        },
      );
      await verify(payload(), requirements);
      vi.advanceTimersByTime(PRIMARY_PROBE_INTERVAL_MS);
      await verify(payload(), requirements);
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith("rpc_probe_failed", {
          component: "rpc",
          network: config.network,
          rpc: rpc(0),
          reason: "lagging",
          lagLedgers: FAILBACK_MAX_LAG_LEDGERS + 1,
        }),
      );
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each RPC URL its own deadline, so a slow second URL still answers", async () => {
    vi.useFakeTimers();
    try {
      const slow = UPSTREAM_TIMEOUT_MS / 2;
      const { verify } = setup((url) =>
        url === "https://rpc-a.example"
          ? new Promise<never>(() => {})
          : new Promise((resolve) => setTimeout(() => resolve({ isValid: true, payer }), slow)),
      );
      const answer = verify(payload(), requirements);
      await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + slow + 1);
      await expect(answer).resolves.toEqual({ isValid: true, payer });
    } finally {
      vi.useRealTimers();
    }
  });

  // With a fixed bid the deadline is 2 × 10 s + slack: without the slack, the overall deadline
  // (set first) and the second URL's own (ending at the same time) would tie, and the overall one
  // would win.
  it("throws the first URL's timeout when every RPC URL hangs, and logs both", async () => {
    vi.useFakeTimers();
    try {
      const { verify, logger } = setup(() => new Promise<never>(() => {}), { config: fixedBid });
      const answer = verify(payload(), requirements);
      const settled = expect(answer).rejects.toThrow(
        new UpstreamTimeoutError(
          `${rpc(0)}: upstream verify gave no answer within ${UPSTREAM_TIMEOUT_MS} ms`,
        ),
      );
      await vi.advanceTimersByTimeAsync(2 * UPSTREAM_TIMEOUT_MS);
      await settled;
      // Each timeout moved the shared client on: [0] → [1], then [1] → [0].
      expect(
        logger.warn.mock.calls
          .filter(([event]) => event === "rpc_failover")
          .map(([, fields]) => [fields.from, fields.to, fields.reason]),
      ).toEqual([
        [rpc(0), rpc(1), "timeout"],
        [rpc(1), rpc(0), "timeout"],
      ]);
      expect(logger.warn).toHaveBeenCalledWith("rpc_exhausted", {
        component: "verify",
        network: config.network,
        tried: [
          { rpc: rpc(0), reason: "timeout" },
          { rpc: rpc(1), reason: "timeout" },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the fee-stats bid before the URL deadlines start, so a slow read costs no URL", async () => {
    vi.useFakeTimers();
    try {
      // Just under the shared client's own 10 s timeout, so the read still answers from [0].
      const { verify, logger } = setup(
        { isValid: true, payer },
        { feeStatsMs: UPSTREAM_TIMEOUT_MS - 1 },
      );
      const trace: VerifyTrace = {};
      const answer = verify(payload(), requirements, trace);
      await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1);
      await expect(answer).resolves.toEqual({ isValid: true, payer });
      // The first URL answered: there was no failover.
      expect(trace).toEqual({ rpc: rpc(0) });
      expect(logger.warn).not.toHaveBeenCalled();
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

describe("upstreamDeadlineMs", () => {
  it("is 10 s per RPC URL, twice that with the fee-stats read before them, plus 1 s", () => {
    expect(upstreamDeadlineMs(2, false)).toBe(21_000);
    expect(upstreamDeadlineMs(2, true)).toBe(41_000);
    expect(upstreamDeadlineMs(1, false)).toBe(11_000);
  });

  it("scales only the per-URL part with a test's timeoutMs, not the fee-stats read", () => {
    // `FallbackRpc` still bounds the bid read at 10 s per URL.
    expect(upstreamDeadlineMs(2, false, 50)).toBe(1_100);
    expect(upstreamDeadlineMs(2, true, 50)).toBe(21_100);
  });

  it("comes with the upstream from buildUpstream, in the fee settings' mode", () => {
    const signer = createEd25519Signer(secret, config.network);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const shared = buildRpc(config, logger, () => ({}) as SorobanRpc);
    const feeStats = feeSettings(config.fees, shared);
    const fixed = feeSettings(fixedBid.fees, shared);
    const deadline = (cfg: Config, fees: FeeSettings) =>
      buildUpstream(cfg, fees, logger, signer, shared).upstreamTimeoutMs;
    expect(deadline(config, feeStats)).toBe(41_000);
    expect(deadline(config, fixed)).toBe(21_000);
    // The mode is the fees', not the config's.
    expect(deadline(fixedBid, feeStats)).toBe(41_000);
  });
});
