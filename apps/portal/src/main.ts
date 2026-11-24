import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PostgresAccountPlanStore,
  PostgresAccountUsageReader,
  PostgresSealedKeyStore,
} from "@stellar-x402/api-keys";
import pg from "pg";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { jsonLogger } from "./logger.js";
import { sealer } from "./seal.js";

export interface Started {
  port: number;
  close(): Promise<void>;
}

/**
 * How long an idle connection stays open: above `cloudflared`'s 90 s idle keep-alive, so the
 * server never closes a connection the tunnel is about to reuse (ADR 0011).
 */
const KEEP_ALIVE_TIMEOUT_MS = 125_000;

/** How long `close()` lets open requests finish before it cuts their connections. */
const SHUTDOWN_GRACE_MS = 10_000;

/** The tables this backend reads and writes. The facilitator's migrations make them. */
const TABLES = ["api_keys", "api_key_copies"];

/**
 * Starts the backend on `env`. It runs no migration: the schema is the facilitator's, and a
 * database without the tables stops it here, naming them.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<Started> {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // A call holds one connection for a moment.
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    statement_timeout: 5_000,
    query_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    application_name: "x402-portal",
  });
  // An idle connection's error would otherwise crash the process.
  pool.on("error", (error) => logger.error("pool_error", { error }));

  try {
    const { rows } = await pool.query<{ missing: string | null }>(
      `SELECT string_agg(name, ', ') AS missing FROM unnest($1::text[]) AS name
       WHERE to_regclass(name) IS NULL`,
      [TABLES],
    );
    if (rows[0]?.missing) {
      throw new Error(
        `the database lacks ${rows[0].missing}: run the facilitator's migrations first`,
      );
    }
  } catch (error) {
    logger.error("startup_failed", { error });
    await pool.end();
    throw error;
  }

  const app = createApp({
    config,
    keys: new PostgresSealedKeyStore(pool),
    plans: new PostgresAccountPlanStore(pool),
    usage: new PostgresAccountUsageReader(pool),
    sealer: sealer(config.keyEncryptionKey),
    logger,
    ready: async () => void (await pool.query("SELECT 1")),
  });
  const server = app.listen(config.port);
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  logger.info("listening", { port });

  let closed: Promise<void> | undefined;
  return {
    port,
    // Memoized: a second signal joins the shutdown under way.
    close: () =>
      (closed ??= (async () => {
        const done = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        const cut = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
        try {
          await done;
        } finally {
          clearTimeout(cut);
          await pool.end();
        }
      })()),
  };
}
