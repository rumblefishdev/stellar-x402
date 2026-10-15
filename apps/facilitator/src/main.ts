import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import {
  FallbackRpc,
  SettlementSubmitter,
  keypairSigner,
  type SorobanRpc,
} from "@stellar-x402/signer-pool";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type pg from "pg";
import { memoryStores } from "./adapters/memory.js";
import { migrate } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createCataloger, type Cataloger } from "./catalog/cataloger.js";
import { parseConfig, parseMigrateConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { supportedResponse } from "./http/supported.js";
import { captureConsoleError, jsonLogger, type Logger } from "./logger.js";
import { memoryMetrics, type Metrics } from "./metrics.js";
import type { SettlementStore } from "./ports/index.js";
import { feeSettings, upstreamAtCurrentBid, type FeeSettings } from "./settlement/fees.js";
import type { SettlementHooks } from "./settlement/hooks.js";
import { SETTLE_MIN_VALIDITY_LEDGERS, createSettler, type Settle } from "./settlement/settle.js";
import { failoverUpstream } from "./settlement/upstream-failover.js";
import {
  createChecker,
  createVerifier,
  type Check,
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
 * How long upstream `verify()` may take on one RPC URL, as `FallbackRpc`'s timeout. With fee-stats
 * bids it includes the fee-stats read, which `upstreamAtCurrentBid` awaits before each call.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Slack on `/verify`'s overall deadline, so the last URL's own deadline fires first. */
const UPSTREAM_DEADLINE_SLACK_MS = 1_000;

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
 * bid. A switch to another RPC URL is logged as `rpc_failover`. Tests pass their own `makeScheme`.
 */
export function buildChecks(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  logger: Pick<Logger, "warn">,
  makeScheme: MakeScheme = (signer, options) => new ExactStellarScheme([signer], options),
): VerifierDeps {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createChecker`'s check (AD-5).
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
    {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      onSwitch: (from, to) => logger.warn("rpc_failover", { from, to }),
    },
  );
  return {
    network: config.network,
    upstream,
    // Each URL gets its own deadline, so the whole call can take one per URL, plus slack.
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS * config.rpcUrls.length + UPSTREAM_DEADLINE_SLACK_MS,
    facilitator: signer.address,
    channels: config.channels,
    minValidityLedgers: config.settlement.minValidityLedgers,
    latestLedger: async () => (await rpc.getLatestLedger()).sequence,
  };
}

/**
 * A test seam: `/verify`'s verifier on checks of its own, {@link buildChecks} through
 * `createVerifier`. `main()` builds the verifier from the checks it shares with `/settle`.
 */
export function buildVerifier(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  logger: Pick<Logger, "warn">,
  makeScheme?: MakeScheme,
): Verify {
  return createVerifier(buildChecks(config, rpc, fees, logger, makeScheme));
}

/**
 * `/settle`'s checks: the same as `/verify`'s, with the pool's validity floor instead of
 * `MIN_VALIDITY_LEDGERS` (AD-22).
 */
export function settleCheck(checks: VerifierDeps): Check {
  return createChecker({ ...checks, minValidityLedgers: SETTLE_MIN_VALIDITY_LEDGERS });
}

/**
 * `/settle` from the config (AD-2, AD-6, AD-10, ADR 0011): the pool, built from the same
 * `fees.pool` as the checks' fees, and the settler with `/settle`'s checks and the settle budget.
 * The pool's events go to the metrics; 0019 finishes the record of a settlement answered
 * `pending`, until then its `resolved` event is logged.
 */
export function buildSettlement(
  config: Config,
  deps: {
    rpc: SorobanRpc;
    fees: FeeSettings;
    checks: VerifierDeps;
    store: SettlementStore;
    hooks: Pick<SettlementHooks, "beforeSubmit" | "onFinal" | "onSuccess">;
    logger: Logger;
    metrics: Metrics;
    /** Tests pass the pool's `sleep`. */
    sleep?: (ms: number) => Promise<void>;
  },
): { settle: Settle; submitter: SettlementSubmitter } {
  const { logger, metrics } = deps;
  // The only sender of transactions in the service (AD-2). The channel check at startup comes
  // with 0020, the lease with 0025.
  const submitter = new SettlementSubmitter({
    rpc: deps.rpc,
    networkPassphrase: getNetworkPassphrase(config.network),
    signer: keypairSigner(Keypair.fromSecret(config.facilitatorSecret)),
    channels: config.channels,
    ...deps.fees.pool,
    ...(deps.sleep && { sleep: deps.sleep }),
    onEvent: (event) => {
      // `resolved` with its status: a pending settlement that ended, for the alarms in 0027.
      metrics.increment(
        "pool_events_total",
        event.type === "resolved"
          ? { type: event.type, status: event.result.status }
          : { type: event.type },
      );
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
    check: settleCheck(deps.checks),
    store: deps.store,
    submitter,
    hooks: deps.hooks,
    logger,
    metrics,
    maxFeeStroops: config.fees.maxFeeStroops,
    settleTimeoutMs: config.settlement.settleTimeoutMs,
    budgetMs: config.settlement.settleBudgetMs,
  });
  return { settle, submitter };
}

/**
 * Every part `main()` serves, built from the config on the given stores: the cataloger, one RPC
 * and one fee configuration shared by `/verify`, `/settle` and the pool. `main()` passes the
 * PostgreSQL stores when `STORE=postgres`; tests pass their own `rpc`, `makeScheme` and pool
 * `sleep`.
 */
export function compose(
  config: Config,
  opts: {
    logger: Logger;
    /** The memory stores when absent. */
    stores?: AppDeps["stores"];
    rpc?: SorobanRpc;
    makeScheme?: MakeScheme;
    sleep?: (ms: number) => Promise<void>;
  },
): { deps: AppDeps; cataloger: Cataloger; metrics: Metrics } {
  const { logger } = opts;
  const stores = opts.stores ?? memoryStores();
  // Cataloging plugs into `/settle` through `extensionResponses` and `onSuccess` (AD-8).
  const metrics = memoryMetrics();
  const cataloger = createCataloger({
    store: stores.catalog,
    logger,
    metrics,
  });
  const rpc = opts.rpc ?? FallbackRpc.fromUrls(config.rpcUrls);
  // One fee configuration: `/verify` and `/settle` check with it, and the pool pays with it, so
  // they share one ceiling and one bid (AD-10).
  const fees = feeSettings(config.fees, rpc);
  const checks = buildChecks(config, rpc, fees, logger, opts.makeScheme);
  const { settle } = buildSettlement(config, {
    rpc,
    fees,
    checks,
    store: stores.settlements,
    // Spend budgets plug in here with 0024.
    hooks: {
      beforeSubmit: async () => ({ allow: true }),
      onFinal: async () => {},
      onSuccess: cataloger.onSuccess,
    },
    logger,
    metrics,
    ...(opts.sleep && { sleep: opts.sleep }),
  });
  return {
    deps: {
      config,
      logger,
      stores,
      verify: createVerifier(checks),
      settle,
      extensionResponses: cataloger.extensionResponses,
      supported: supportedResponse(config.network, checks.facilitator),
    },
    cataloger,
    metrics,
  };
}

/**
 * The composition root (AD-1): the only module that reads `process.env`. It validates the config
 * once and builds every part from it ({@link compose}).
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel, undefined, config.rpcUrls);
  // STORE=postgres needs a migrated schema (`pnpm migrate`); the service never migrates it.
  let pools: { main: pg.Pool; reserve: pg.Pool; rateLimits: pg.Pool } | undefined;
  if (config.store === "postgres") {
    const url = config.databaseUrl;
    if (url === undefined) throw new Error("STORE=postgres needs a DATABASE_URL");
    // Reservations queue on the global scope's lock, and a flood's hits on its key's row lock;
    // their own pools keep those queues off the others.
    pools = {
      main: createPool(url, poolErrorLogger(logger)),
      reserve: createPool(url, poolErrorLogger(logger), 3),
      rateLimits: createPool(url, poolErrorLogger(logger), 3),
    };
  }
  const endPools = () => Promise.all(Object.values(pools ?? {}).map((p) => p.end()));
  try {
    const stores = pools ? postgresStores(pools.main, pools) : memoryStores();
    const { deps, cataloger } = compose(config, { logger, stores });
    // For the life of the process: an upstream call cut off by the deadline keeps running after
    // `close()`, and its error would reach stderr with the RPC URL in it.
    const restoreConsole = captureConsoleError(logger, config.rpcUrls);
    const started = await start(deps).catch((error: unknown) => {
      restoreConsole();
      throw error;
    });
    // Catalog writes already under way finish before the process exits, and before the pools
    // end, even if closing the server fails; the pools end even if draining fails.
    const closeOnce = async () => {
      try {
        await started.close();
      } finally {
        try {
          await cataloger.drain();
        } finally {
          await endPools();
        }
      }
    };
    let closing: Promise<void> | undefined;
    return {
      ...started,
      /** The graph's stores, and with `STORE=postgres` its pools: for tests. */
      stores,
      pools,
      /** The logger every part writes to: for tests. */
      logger,
      // A second signal (SIGINT after SIGTERM) gets the first call's promise: running it again
      // would end the pools under requests the first is still waiting for.
      close: () => (closing ??= closeOnce()),
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
