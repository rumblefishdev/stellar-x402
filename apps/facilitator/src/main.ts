import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { FallbackRpc } from "@stellar-x402/signer-pool";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { memoryStores } from "./adapters/memory.js";
import { createCataloger } from "./catalog/cataloger.js";
import { parseConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { captureConsoleError, jsonLogger, type Logger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";
import { atCurrentBid, feeSettings, type FeeSettings } from "./settlement/fees.js";
import { failoverUpstream } from "./settlement/upstream-failover.js";
import {
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
 * How long upstream `verify()` may take on one RPC URL, the same as `FallbackRpc`'s timeout. The
 * fee-stats bid is read before it starts (AD-10), so it covers the upstream call alone.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Slack on the whole upstream call's deadline, so the last URL's own deadline fires first. */
export const UPSTREAM_DEADLINE_SLACK_MS = 1_000;

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

/**
 * Upstream verify from the config, with its deadline (AD-3, AD-10): one `ExactStellarScheme` per
 * `RPC_URLS` entry, with the fee ceiling and the fee a settlement pays at the shared bid, read once
 * per call, behind `failoverUpstream`. A switch to another RPC URL is logged as `rpc_failover`.
 * The two belong together: spread both into `VerifierDeps`, or the deadline falls back to 10 s and
 * cuts off the second URL. Tests pass their own `makeScheme`.
 */
export function buildUpstream(
  config: Config,
  fees: FeeSettings,
  logger: Pick<Logger, "warn">,
  makeScheme: MakeScheme = (signer, options) => new ExactStellarScheme([signer], options),
): Pick<VerifierDeps, "upstream" | "upstreamTimeoutMs"> {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createVerifier`'s check (AD-5).
  const signer = createEd25519Signer(config.facilitatorSecret, config.network);
  // Upstream reads one RPC URL, so there is one scheme per URL, tried in `RPC_URLS` order.
  const endpoints = atCurrentBid(fees.inclusionFee, (inclusionFeeStroops) =>
    config.rpcUrls.map((url, i) => ({
      name: `RPC_URLS[${i}]`,
      verifier: makeScheme(signer, {
        rpcConfig: { url },
        maxTransactionFeeStroops: fees.maxFeeStroops,
        inclusionFeeStroops,
      }),
    })),
  );
  return {
    upstream: failoverUpstream(endpoints, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      onSwitch: (from, to) => logger.warn("rpc_failover", { from, to }),
    }),
    upstreamTimeoutMs: upstreamDeadlineMs(
      config.rpcUrls.length,
      config.fees.inclusionFeeStroops === undefined,
    ),
  };
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
  logger: Pick<Logger, "warn">,
  makeScheme?: MakeScheme,
): Verify {
  return createVerifier({
    network: config.network,
    ...buildUpstream(config, fees, logger, makeScheme),
    facilitator: createEd25519Signer(config.facilitatorSecret, config.network).address,
    channels: config.channels,
    minValidityLedgers: config.settlement.minValidityLedgers,
    latestLedger: async () => (await rpc.getLatestLedger()).sequence,
  });
}

/**
 * The composition root (AD-1): the only module that reads `process.env`. It validates the config
 * once and builds every part from it.
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel);
  // STORE=memory is the only option until the durable adapters land (0022).
  const stores = memoryStores();
  // 0009 hands its `extensionResponses` and `onSuccess` to `/settle` as `SettlementHooks`.
  const cataloger = createCataloger({
    store: stores.catalog,
    logger,
    metrics: memoryMetrics(),
    allowHttp: config.catalog.allowHttp,
  });
  const rpc = FallbackRpc.fromUrls(config.rpcUrls);
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
