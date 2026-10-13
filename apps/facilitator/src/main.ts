import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { FallbackRpc, SettlementSubmitter, keypairSigner } from "@stellar-x402/signer-pool";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { memoryStores } from "./adapters/memory.js";
import { createCataloger } from "./catalog/cataloger.js";
import { parseConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { captureConsoleError, jsonLogger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";
import { feeSettings, upstreamAtCurrentBid, type FeeSettings } from "./settlement/fees.js";
import { createSettler } from "./settlement/settle.js";
import {
  createChecker,
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

/** What `buildChecks` passes to `ExactStellarScheme`, besides the facilitator's signer. */
export type SchemeOptions = NonNullable<ConstructorParameters<typeof ExactStellarScheme>[1]>;

export type MakeScheme = (
  signer: ReturnType<typeof createEd25519Signer>,
  options: SchemeOptions,
) => UpstreamVerifier;

/**
 * The verify checks' dependencies from the config (AD-3, AD-5, AD-10, AD-22): upstream
 * `ExactStellarScheme` with the fee ceiling and the fee a settlement pays at the shared bid, the
 * channels and the validity minimum. `/verify` and `/settle` build their checks from the same
 * object. `fees` is the caller's, so the pool is built from the same `fees.pool` and shares its
 * bid. Tests pass their own `makeScheme`.
 */
export function buildChecks(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  makeScheme: MakeScheme = (signer, options) => new ExactStellarScheme([signer], options),
): VerifierDeps {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createVerifier`'s check (AD-5).
  // It reads the first RPC URL only.
  const signer = createEd25519Signer(config.facilitatorSecret, config.network);
  const upstream = upstreamAtCurrentBid(fees.inclusionFee, (inclusionFeeStroops) =>
    makeScheme(signer, {
      rpcConfig: { url: config.rpcUrls[0] },
      maxTransactionFeeStroops: fees.maxFeeStroops,
      inclusionFeeStroops,
    }),
  );
  return {
    network: config.network,
    upstream,
    facilitator: signer.address,
    channels: config.channels,
    minValidityLedgers: config.settlement.minValidityLedgers,
    latestLedger: async () => (await rpc.getLatestLedger()).sequence,
  };
}

/** `/verify`'s verifier: {@link buildChecks} through `createVerifier`. */
export function buildVerifier(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  makeScheme?: MakeScheme,
): Verify {
  return createVerifier(buildChecks(config, rpc, fees, makeScheme));
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
  // Cataloging plugs into `/settle` through `extensionResponses` and `onSuccess` (AD-8).
  const metrics = memoryMetrics();
  const cataloger = createCataloger({
    store: stores.catalog,
    logger,
    metrics,
    allowHttp: config.catalog.allowHttp,
  });
  const rpc = FallbackRpc.fromUrls(config.rpcUrls);
  // One fee configuration: `/verify` and `/settle` check with it, and the pool pays with it, so
  // they share one ceiling and one bid (AD-10).
  const fees = feeSettings(config.fees, rpc);
  const checks = buildChecks(config, rpc, fees);
  // The only sender of transactions in the service (AD-2). The channel check at startup comes
  // with 0020, the lease with 0025.
  const submitter = new SettlementSubmitter({
    rpc,
    networkPassphrase: getNetworkPassphrase(config.network),
    signer: keypairSigner(Keypair.fromSecret(config.facilitatorSecret)),
    channels: config.channels,
    ...fees.pool,
    onEvent: (event) => {
      // 0019 finishes the record of a settlement answered `pending`; until then it's logged.
      if (event.type === "resolved") {
        logger.info("settlement_resolved", {
          network: config.network,
          transaction: event.result.hash,
          status: event.result.status,
        });
      }
    },
  });
  const settle = createSettler({
    network: config.network,
    check: createChecker(checks),
    store: stores.settlements,
    submitter,
    // Spend budgets plug in here with 0024.
    hooks: {
      beforeSubmit: async () => ({ allow: true }),
      onFinal: async () => {},
      onSuccess: cataloger.onSuccess,
    },
    logger,
    metrics,
    maxFeeStroops: config.fees.maxFeeStroops,
    settleTimeoutMs: config.settlement.settleTimeoutMs,
    budgetMs: config.settlement.settleBudgetMs,
  });
  // For the life of the process: an upstream call cut off by the deadline keeps running after
  // `close()`, and its error would reach stderr with the RPC URL in it.
  const restoreConsole = captureConsoleError(logger);
  const started = await start({
    config,
    logger,
    stores,
    verify: createVerifier(checks),
    settle,
    extensionResponses: cataloger.extensionResponses,
  }).catch((error: unknown) => {
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
