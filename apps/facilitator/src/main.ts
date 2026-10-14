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
import { captureConsoleError, jsonLogger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";
import { feeSettings, upstreamAtCurrentBid, type FeeSettings } from "./settlement/fees.js";
import { failoverUpstream } from "./settlement/upstream-failover.js";
import { createVerifier, type UpstreamVerifier, type Verify } from "./settlement/verify.js";

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

/** How long upstream `verify()` may take on one RPC URL, as `FallbackRpc`'s timeout. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** What `buildVerifier` passes to `ExactStellarScheme`, besides the facilitator's signer. */
export type SchemeOptions = NonNullable<ConstructorParameters<typeof ExactStellarScheme>[1]>;

/**
 * `/verify`'s verifier from the config (AD-3, AD-5, AD-10, AD-22): upstream `ExactStellarScheme`
 * with the fee ceiling and the fee a settlement pays at the shared bid, then our checks. `fees` is
 * the caller's, so the pool can be built from the same `fees.pool` and share its bid. Tests pass
 * their own `makeScheme`.
 */
export function buildVerifier(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  makeScheme: (
    signer: ReturnType<typeof createEd25519Signer>,
    options: SchemeOptions,
  ) => UpstreamVerifier = (signer, options) => new ExactStellarScheme([signer], options),
): Verify {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createVerifier`'s check (AD-5).
  const signer = createEd25519Signer(config.facilitatorSecret, config.network);
  // Upstream reads one RPC URL, so there is one scheme per URL, tried in `RPC_URLS` order (AD-3).
  const upstream = failoverUpstream(
    config.rpcUrls.map((url, i) => ({
      name: `RPC_URLS[${i}]`,
      verifier: upstreamAtCurrentBid(fees.inclusionFee, (inclusionFeeStroops) =>
        makeScheme(signer, {
          rpcConfig: { url },
          maxTransactionFeeStroops: fees.maxFeeStroops,
          inclusionFeeStroops,
        }),
      ),
    })),
    { timeoutMs: UPSTREAM_TIMEOUT_MS },
  );
  return createVerifier({
    network: config.network,
    upstream,
    // Each URL gets its own deadline, so the whole call can take one per URL.
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS * config.rpcUrls.length,
    facilitator: signer.address,
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
  const verify = buildVerifier(config, rpc, fees);
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
