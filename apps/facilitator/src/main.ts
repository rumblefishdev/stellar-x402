import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { FallbackRpc } from "@stellar-x402/signer-pool";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type pg from "pg";
import { memoryStores } from "./adapters/memory.js";
import { migrate } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createCataloger } from "./catalog/cataloger.js";
import { parseConfig, parseMigrateConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { captureConsoleError, jsonLogger, type Logger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";
import { feeSettings, upstreamAtCurrentBid, type FeeSettings } from "./settlement/fees.js";
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
  // It reads the first RPC URL only.
  const signer = createEd25519Signer(config.facilitatorSecret, config.network);
  const upstream = upstreamAtCurrentBid(fees.inclusionFee, (inclusionFeeStroops) =>
    makeScheme(signer, {
      rpcConfig: { url: config.rpcUrls[0] },
      maxTransactionFeeStroops: fees.maxFeeStroops,
      inclusionFeeStroops,
    }),
  );
  return createVerifier({
    network: config.network,
    upstream,
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
  // STORE=postgres needs a migrated schema (`pnpm migrate`); the service never migrates it.
  let pool: pg.Pool | undefined;
  let reservePool: pg.Pool | undefined;
  if (config.store === "postgres") {
    if (config.databaseUrl === undefined) throw new Error("STORE=postgres needs a DATABASE_URL");
    pool = createPool(config.databaseUrl, poolErrorLogger(logger));
    // Reservations queue on the global scope's lock; their own pool keeps them off the others.
    reservePool = createPool(config.databaseUrl, poolErrorLogger(logger), 3);
  }
  const endPools = () => Promise.all([pool?.end(), reservePool?.end()]);
  try {
    const stores = pool ? postgresStores(pool, reservePool) : memoryStores();
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
      // Catalog writes already under way finish before the process exits, and before the pools
      // end; the pools end even if closing or draining fails.
      close: async () => {
        try {
          await started.close();
          await cataloger.drain();
        } finally {
          await endPools();
        }
      },
    };
  } catch (error) {
    await endPools();
    throw error;
  }
}

/** Logs an idle connection's error with its message only; the URL never reaches the log. */
function poolErrorLogger(logger: Logger) {
  return (error: Error) => logger.warn("store_connection_error", { message: error.message });
}

/**
 * `pnpm migrate`: applies the pending PostgreSQL migrations and logs their names. It needs only
 * `DATABASE_URL`, and is the only path that changes the schema.
 */
export async function migrateMain(env: Record<string, string | undefined> = process.env) {
  const { databaseUrl } = parseMigrateConfig(env);
  const logger = jsonLogger("info");
  const pool = createPool(databaseUrl, poolErrorLogger(logger));
  try {
    const applied = await migrate(pool);
    logger.info("migrated", { applied });
  } finally {
    await pool.end();
  }
}
