import { RpcTimeoutError, type FallbackRpc } from "@stellar-x402/signer-pool";
import type { FacilitatorStellarSigner } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type { Config } from "../config.js";
import { rpcEndpointName, type Logger } from "../logger.js";
import { atCurrentBid, type FeeSettings } from "./fees.js";
import { failoverUpstream, type EndpointFailure } from "./upstream-failover.js";
import {
  UNEXPECTED_VERIFY_ERROR,
  UpstreamTimeoutError,
  type UpstreamVerifier,
  type VerifierDeps,
} from "./verify.js";

/**
 * How long upstream `verify()` may take on one RPC URL, the same as `FallbackRpc`'s timeout, which
 * `main()` sets to it. The fee-stats bid is read before it starts (AD-10), so it covers the
 * upstream call alone. Also the bound of each probe read and of undici's header and body waits.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * How long upstream's Horizon read of the ledger time may wait for headers or body data: Horizon
 * answers in under 1 s (0.46 to 0.73 s, 30 calls on testnet, 2026-11-05), and upstream falls back
 * to 5 s a ledger when the read fails, so a hung Horizon costs a payment 2 s, not every RPC URL.
 */
export const HORIZON_TIMEOUT_MS = 2_000;

/** Slack on the whole upstream call's deadline, so the last URL's own deadline fires first. */
export const UPSTREAM_DEADLINE_SLACK_MS = 1_000;

/**
 * The deadline of the whole upstream call (AD-3): `timeoutMs` (10 s) for each of `urls` RPC URLs,
 * plus, with fee-stats bids, the bid read before them, which `FallbackRpc` bounds at 10 s per URL,
 * plus 1 s of slack. The AD-22 ledger read and the trustline lookup after it are not included.
 */
export function upstreamDeadlineMs(
  urls: number,
  feeStats: boolean,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): number {
  return (timeoutMs + (feeStats ? UPSTREAM_TIMEOUT_MS : 0)) * urls + UPSTREAM_DEADLINE_SLACK_MS;
}

/** What `buildUpstream` passes to `ExactStellarScheme`, besides the facilitator's signer. */
export type SchemeOptions = NonNullable<ConstructorParameters<typeof ExactStellarScheme>[1]>;

export type MakeScheme = (
  signer: FacilitatorStellarSigner,
  options: SchemeOptions,
) => UpstreamVerifier;

/**
 * Test seams of {@link buildUpstream}: the scheme per URL, and how long one URL may take
 * (`UPSTREAM_TIMEOUT_MS` by default), so a hung URL needn't cost a test 10 s.
 */
export interface UpstreamSeams {
  makeScheme?: MakeScheme;
  timeoutMs?: number;
}

/** A short, URL-free reason for the logs: an error's message can carry an RPC URL. */
export function failureReason(failure: EndpointFailure | { error: unknown }): string {
  if ("answer" in failure) return UNEXPECTED_VERIFY_ERROR;
  const { error } = failure;
  if (error instanceof UpstreamTimeoutError || error instanceof RpcTimeoutError) return "timeout";
  return error instanceof Error ? `error:${error.name}` : "error";
}

/**
 * Upstream verify from the config, with its deadline (AD-3, AD-10): one `ExactStellarScheme` per
 * `RPC_URLS` entry, with the fee ceiling and the fee a settlement pays at the shared bid, read once
 * per call, behind `failoverUpstream`, which starts each call on `active`'s URL (the shared
 * {@link buildRpc}) and reports a throw or a timeout there. Logs `rpc_exhausted` (warn, with
 * `component: "verify"`, the network and `RPC_URLS[i]#…` names) when every URL failed; switches
 * are `active`'s to log.
 * The two belong together: spread both into `VerifierDeps`, or the deadline falls back to 10 s and
 * cuts off the second URL.
 */
export function buildUpstream(
  config: Config,
  fees: FeeSettings,
  logger: Pick<Logger, "warn">,
  facilitator: FacilitatorStellarSigner,
  active: Pick<FallbackRpc, "begin" | "markFailed">,
  seams: UpstreamSeams = {},
): Pick<VerifierDeps, "upstream" | "upstreamTimeoutMs"> {
  const {
    makeScheme = (signer, options) => new ExactStellarScheme([signer], options),
    timeoutMs = UPSTREAM_TIMEOUT_MS,
  } = seams;
  // `RPC_URLS[i]#<fingerprint>`, as everywhere else in the logs (ADR 0011, 0009 decision 47).
  const name = (i: number) => rpcEndpointName(config.rpcUrls[i]!, i);
  // Upstream reads one RPC URL, so there is one scheme per URL, in `RPC_URLS` order: the order of
  // `active`'s endpoints.
  const endpoints = atCurrentBid(fees.inclusionFee, (inclusionFeeStroops) =>
    config.rpcUrls.map((url, i) => ({
      name: name(i),
      verifier: makeScheme(facilitator, {
        rpcConfig: { url },
        maxTransactionFeeStroops: fees.maxFeeStroops,
        inclusionFeeStroops,
      }),
    })),
  );
  return {
    upstream: failoverUpstream(endpoints, {
      timeoutMs,
      active,
      onExhausted: (tried) =>
        logger.warn("rpc_exhausted", {
          component: "verify",
          network: config.network,
          tried: tried.map((t) => ({ rpc: t.name, reason: failureReason(t.failure) })),
        }),
    }),
    upstreamTimeoutMs: upstreamDeadlineMs(config.rpcUrls.length, fees.feeStats, timeoutMs),
  };
}
