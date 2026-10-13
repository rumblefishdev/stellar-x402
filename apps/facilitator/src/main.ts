import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { memoryStores } from "./adapters/memory.js";
import { migrate } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createCataloger } from "./catalog/cataloger.js";
import { parseConfig, parseMigrateConfig } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { jsonLogger, type Logger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";

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
 * The composition root (AD-1): the only module that reads `process.env`. It validates the config
 * once and builds every part from it.
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel);
  // STORE=postgres needs a migrated schema (`pnpm migrate`); the service never migrates it.
  let pool: pg.Pool | undefined;
  if (config.store === "postgres") {
    if (config.databaseUrl === undefined) throw new Error("STORE=postgres needs a DATABASE_URL");
    pool = createPool(config.databaseUrl, poolErrorLogger(logger));
  }
  try {
    const stores = pool ? postgresStores(pool) : memoryStores();
    // 0009 hands its `extensionResponses` and `onSuccess` to `/settle` as `SettlementHooks`.
    const cataloger = createCataloger({
      store: stores.catalog,
      logger,
      metrics: memoryMetrics(),
      allowHttp: config.catalog.allowHttp,
    });
    const started = await start({ config, logger, stores });
    return {
      ...started,
      // Catalog writes already under way finish before the process exits, and before the pool
      // ends; the pool ends even if closing or draining fails.
      close: async () => {
        try {
          await started.close();
          await cataloger.drain();
        } finally {
          await pool?.end();
        }
      },
    };
  } catch (error) {
    await pool?.end();
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
