import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair, rpc as stellarRpc } from "@stellar/stellar-sdk";
import {
  FallbackRpc,
  SettlementSubmitter,
  keypairSigner,
  type SorobanRpc,
} from "@stellar-x402/signer-pool";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type pg from "pg";
import { Agent, setGlobalDispatcher } from "undici";
import { memoryStores } from "./adapters/memory.js";
import { migrate } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createCataloger, type Cataloger } from "./catalog/cataloger.js";
import { parseConfig, parseMigrateConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { supportedResponse } from "./http/supported.js";
import { captureConsoleError, jsonLogger, rpcEndpointName, type Logger } from "./logger.js";
import { memoryMetrics, type Metrics } from "./metrics.js";
import type { SettlementStore } from "./ports/index.js";
import { atCurrentBid, feeSettings, type FeeSettings } from "./settlement/fees.js";
import type { SettlementHooks } from "./settlement/hooks.js";
import { SETTLE_MIN_VALIDITY_LEDGERS, createSettler, type Settle } from "./settlement/settle.js";
import { failoverUpstream, type EndpointFailure } from "./settlement/upstream-failover.js";
import {
  UNEXPECTED_VERIFY_ERROR,
  UpstreamTimeoutError,
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
 * The deadline of the whole upstream call (AD-3): `timeoutMs` (10 s) for each of `urls` RPC URLs,
 * plus, with fee-stats bids, the bid read before them, which `FallbackRpc` bounds at 10 s per URL,
 * plus 1 s of slack. The AD-22 ledger read after it is not included.
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
  signer: ReturnType<typeof createEd25519Signer>,
  options: SchemeOptions,
) => UpstreamVerifier;

/**
 * Test seams of {@link buildUpstream}: the scheme per URL, the probe's ledger read per URL, and how
 * long one URL may take (`UPSTREAM_TIMEOUT_MS` by default), so a hung URL needn't cost a test 10 s.
 */
export interface UpstreamSeams {
  makeScheme?: MakeScheme;
  latestLedger?: (url: string) => Promise<number>;
  timeoutMs?: number;
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
 * calls are off it. Logs, each with `component: "verify"`, the network and `RPC_URLS[i]#…` names:
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
    timeoutMs = UPSTREAM_TIMEOUT_MS,
  } = seams;
  // `RPC_URLS[i]#<fingerprint>`, as everywhere else in the logs (ADR 0011, 0009 decision 47).
  const name = (i: number) => rpcEndpointName(config.rpcUrls[i]!, i);
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
      timeoutMs,
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
    upstreamTimeoutMs: upstreamDeadlineMs(config.rpcUrls.length, fees.feeStats, timeoutMs),
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
 * The verify checks' dependencies from the config (AD-3, AD-5, AD-10, AD-22): {@link buildUpstream},
 * the channels and the validity minimum. `/verify` and `/settle` build their checks from the same
 * object. `fees` is the caller's, so the pool is built from the same `fees.pool` and shares its
 * bid.
 */
export function buildChecks(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger">,
  fees: FeeSettings,
  logger: Pick<Logger, "warn" | "info">,
  seams?: UpstreamSeams,
): VerifierDeps {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createChecker`'s check (AD-5).
  const facilitator = createEd25519Signer(config.facilitatorSecret, config.network);
  return {
    network: config.network,
    ...buildUpstream(config, fees, logger, facilitator, seams),
    facilitator: facilitator.address,
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
  logger: Pick<Logger, "warn" | "info">,
  seams?: UpstreamSeams,
): Verify {
  return createVerifier(buildChecks(config, rpc, fees, logger, seams));
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
    seams?: UpstreamSeams;
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
    allowHttp: config.catalog.allowHttp,
  });
  const rpc = opts.rpc ?? FallbackRpc.fromUrls(config.rpcUrls, { timeoutMs: UPSTREAM_TIMEOUT_MS });
  // One fee configuration: `/verify` and `/settle` check with it, and the pool pays with it, so
  // they share one ceiling and one bid (AD-10).
  const fees = feeSettings(config.fees, rpc);
  const checks = buildChecks(config, rpc, fees, logger, opts.seams);
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

export interface MainOptions {
  /** Where the log lines go; stdout by default. The smoke scripts read them here. */
  write?: (line: string) => void;
}

/**
 * The composition root (AD-1): the only module that reads `process.env`. It validates the config
 * once and builds every part from it ({@link compose}).
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
  opts: MainOptions = {},
) {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel, opts.write, config.rpcUrls);
  // stellar-sdk's RPC and Horizon clients use the global fetch with no timeout of their own, and an
  // upstream call cut off by its deadline can't be cancelled. undici's defaults would hold its
  // socket for 300 s; these end it after 10 s without headers or body data. Process-wide: any other
  // `fetch` in this process gets the same bounds (the facilitator makes no other).
  setGlobalDispatcher(
    new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS }),
  );
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
