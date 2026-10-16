import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { FallbackRpc } from "@stellar-x402/signer-pool";
import { rpc as stellarRpc } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { Agent, setGlobalDispatcher } from "undici";
import { memoryStores } from "./adapters/memory.js";
import { createCataloger } from "./catalog/cataloger.js";
import { parseConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { captureConsoleError, jsonLogger, type Logger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";
import { atCurrentBid, feeSettings, type FeeSettings } from "./settlement/fees.js";
import { failoverUpstream, type EndpointFailure } from "./settlement/upstream-failover.js";
import {
  UNEXPECTED_VERIFY_ERROR,
  UpstreamTimeoutError,
  createVerifier,
  type UpstreamVerifier,
  type VerifierDeps,
  type Verify,
} from "./settlement/verify.js";

export interface Started {
  port: number;
  close(): Promise<void>;
}

/** Starts the HTTP server on the graph `deps`. Tests call it with their own config and stores. */
export async function start(deps: AppDeps): Promise<Started> {
  const server = createApp(deps).listen(deps.config.port);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  deps.logger.info("listening", {
    port,
    network: deps.config.network,
    store: deps.config.store,
    channels: deps.config.channels.length,
  });
  return {
    port,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/**
 * How long upstream `verify()` may take on one RPC URL, the same as `FallbackRpc`'s timeout, which
 * `main()` sets to it. The fee-stats bid is read before it starts (AD-10), so it covers the
 * upstream call alone. Also the bound of each probe read and of undici's header and body waits.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Slack on the whole upstream call's deadline, so the last URL's own deadline fires first. */
export const UPSTREAM_DEADLINE_SLACK_MS = 1_000;

/** How often upstream verify probes `RPC_URLS[0]` while calls are off it (AD-3). */
export const PRIMARY_PROBE_INTERVAL_MS = 60_000;

/** How many ledgers `RPC_URLS[0]` may trail the active URL by when calls return to it (AD-3). */
export const FAILBACK_MAX_LAG_LEDGERS = 2;

/**
 * The deadline of the whole upstream call (AD-3): 10 s for each of `urls` RPC URLs, plus, with
 * fee-stats bids, the bid read before them, which `FallbackRpc` bounds at 10 s per URL, plus 1 s of
 * slack. The AD-22 ledger read after it is not included.
 */
export function upstreamDeadlineMs(urls: number, feeStats: boolean): number {
  return UPSTREAM_TIMEOUT_MS * urls * (feeStats ? 2 : 1) + UPSTREAM_DEADLINE_SLACK_MS;
}

/** What `buildUpstream` passes to `ExactStellarScheme`, besides the facilitator's signer. */
export type SchemeOptions = NonNullable<ConstructorParameters<typeof ExactStellarScheme>[1]>;

export type MakeScheme = (
  signer: ReturnType<typeof createEd25519Signer>,
  options: SchemeOptions,
) => UpstreamVerifier;

/** Test seams of {@link buildUpstream}: the scheme per URL and the probe's ledger read per URL. */
export interface UpstreamSeams {
  makeScheme?: MakeScheme;
  latestLedger?: (url: string) => Promise<number>;
}

/** A short, URL-free reason for the logs: an error's message can carry an RPC URL. */
export function failureReason(failure: EndpointFailure | { error: unknown }): string {
  if ("answer" in failure) return UNEXPECTED_VERIFY_ERROR;
  const { error } = failure;
  if (error instanceof UpstreamTimeoutError) return "timeout";
  return error instanceof Error ? `error:${error.name}` : "error";
}

/**
 * Upstream verify from the config, with its deadline (AD-3, AD-10): one `ExactStellarScheme` per
 * `RPC_URLS` entry, with the fee ceiling and the fee a settlement pays at the shared bid, read once
 * per call, behind `failoverUpstream`, which probes `RPC_URLS[0]` with its own `rpc.Server` while
 * calls are off it. Logs, each with `component: "verify"`, the network and `RPC_URLS[i]` names:
 * `rpc_failover` (warn) on a switch, `rpc_failback` (info) on the return to the first URL,
 * `rpc_probe_failed` (warn), and `rpc_exhausted` (warn) when every URL failed.
 * The two belong together: spread both into `VerifierDeps`, or the deadline falls back to 10 s and
 * cuts off the second URL.
 */
export function buildUpstream(
  config: Config,
  fees: FeeSettings,
  logger: Pick<Logger, "warn" | "info">,
  facilitator: ReturnType<typeof createEd25519Signer>,
  seams: UpstreamSeams = {},
): Pick<VerifierDeps, "upstream" | "upstreamTimeoutMs"> {
  const {
    makeScheme = (signer, options) => new ExactStellarScheme([signer], options),
    latestLedger = rpcLatestLedger(config.rpcUrls),
  } = seams;
  const name = (i: number) => `RPC_URLS[${i}]`;
  // Upstream reads one RPC URL, so there is one scheme per URL, tried in `RPC_URLS` order.
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
  const fields = { component: "verify", network: config.network };
  return {
    upstream: failoverUpstream(endpoints, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      probeIntervalMs: PRIMARY_PROBE_INTERVAL_MS,
      maxLagLedgers: FAILBACK_MAX_LAG_LEDGERS,
      latestLedger: (i) => latestLedger(config.rpcUrls[i]!),
      onSwitch: (from, to, failure) =>
        logger.warn("rpc_failover", { ...fields, from, to, reason: failureReason(failure) }),
      onFailback: (from, to, lagLedgers) =>
        logger.info("rpc_failback", { ...fields, from, to, lagLedgers }),
      onProbeFailed: (rpc, failure) =>
        logger.warn("rpc_probe_failed", {
          ...fields,
          rpc,
          ...("lagLedgers" in failure
            ? { reason: "lagging", lagLedgers: failure.lagLedgers }
            : { reason: failureReason(failure) }),
        }),
      onExhausted: (tried) =>
        logger.warn("rpc_exhausted", {
          ...fields,
          tried: tried.map((t) => ({ rpc: t.name, reason: failureReason(t.failure) })),
        }),
    }),
    upstreamTimeoutMs: upstreamDeadlineMs(config.rpcUrls.length, fees.feeStats),
  };
}

/** The probe's ledger read: one `rpc.Server` per URL, apart from `FallbackRpc`'s. */
function rpcLatestLedger(urls: readonly string[]): (url: string) => Promise<number> {
  const servers = new Map(
    urls.map((url) => [url, new stellarRpc.Server(url, { allowHttp: url.startsWith("http:") })]),
  );
  return async (url) => (await servers.get(url)!.getLatestLedger()).sequence;
}

/**
 * `/verify`'s verifier from the config (AD-3, AD-5, AD-10, AD-22): {@link buildUpstream}, then our
 * checks. `fees` is the caller's, so the pool can be built from the same `fees.pool` and share its
 * bid.
 */
export function buildVerifier(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  logger: Pick<Logger, "warn" | "info">,
  seams?: UpstreamSeams,
): Verify {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createVerifier`'s check (AD-5).
  const facilitator = createEd25519Signer(config.facilitatorSecret, config.network);
  return createVerifier({
    network: config.network,
    ...buildUpstream(config, fees, logger, facilitator, seams),
    facilitator: facilitator.address,
    channels: config.channels,
    minValidityLedgers: config.settlement.minValidityLedgers,
    latestLedger: async () => (await rpc.getLatestLedger()).sequence,
  });
}

export interface MainOptions {
  /** Where the log lines go; stdout by default. The smoke scripts read them here. */
  write?: (line: string) => void;
}

/**
 * The composition root (AD-1): the only module that reads `process.env`. It validates the config
 * once and builds every part from it.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
  opts: MainOptions = {},
) {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel, opts.write);
  // stellar-sdk's RPC and Horizon clients use the global fetch with no timeout of their own, and an
  // upstream call cut off by its deadline can't be cancelled. undici's defaults would hold its
  // socket for 300 s; these end it after 10 s without headers or body data. Process-wide: any other
  // `fetch` in this process gets the same bounds (the facilitator makes no other).
  setGlobalDispatcher(
    new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS }),
  );
  // STORE=memory is the only option until the durable adapters land (0022).
  const stores = memoryStores();
  // 0009 hands its `extensionResponses` and `onSuccess` to `/settle` as `SettlementHooks`.
  const cataloger = createCataloger({
    store: stores.catalog,
    logger,
    metrics: memoryMetrics(),
    allowHttp: config.catalog.allowHttp,
  });
  const rpc = FallbackRpc.fromUrls(config.rpcUrls, { timeoutMs: UPSTREAM_TIMEOUT_MS });
  // 0009 builds the pool from `fees.pool`, so `/verify` and the pool share one bid (AD-10).
  const fees = feeSettings(config.fees, rpc);
  const verify = buildVerifier(config, rpc, fees, logger);
  // For the life of the process: an upstream call cut off by the deadline keeps running after
  // `close()`, and its error would reach stderr with the RPC URL in it.
  const restoreConsole = captureConsoleError(logger);
  const started = await start({ config, logger, stores, verify }).catch((error: unknown) => {
    restoreConsole();
    throw error;
  });
  return {
    ...started,
    // Catalog writes already under way finish before the process exits.
    close: async () => {
      await started.close();
      await cataloger.drain();
    },
  };
}
