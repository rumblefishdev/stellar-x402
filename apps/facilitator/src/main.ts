import { rpc as stellarRpc } from "@stellar/stellar-sdk";
import {
  FallbackRpc,
  SettlementSubmitter,
  type SorobanRpc,
  type TransactionSigner,
} from "@stellar-x402/signer-pool";
import {
  DEFAULT_PUBNET_HORIZON_URL,
  DEFAULT_TESTNET_HORIZON_URL,
  getNetworkPassphrase,
  getUsdcAddress,
  type FacilitatorStellarSigner,
} from "@x402/stellar";
import type pg from "pg";
import { setGlobalDispatcher } from "undici";
import { emfMetrics } from "./adapters/emf-metrics.js";
import { boundedAgent } from "./adapters/http-timeouts.js";
import { openBaoSigner, type OpenBaoSigner } from "./adapters/openbao-signer.js";
import { MIGRATIONS, migrate, pendingMigrations } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createCataloger, type Cataloger } from "./catalog/cataloger.js";
import { parseConfig, parseMigrateConfig } from "./config.js";
import type { Config } from "./config.js";
import type { AppDeps } from "./http/app.js";
import { supportedResponse } from "./http/supported.js";
import { captureConsoleError, jsonLogger, rpcEndpointName, type Logger } from "./logger.js";
import { memoryMetrics, type NetworkMetrics, type ProcessMetrics } from "./metrics.js";
import type { LeaseFence, SettlementStore } from "./ports/index.js";
import { createPruner } from "./pruner.js";
import { createRpcStallTracker, type RpcStallTracker } from "./rpc-stall.js";
import { checkChannels } from "./settlement/channel-check.js";
import { checkRpcNetworks } from "./settlement/network-check.js";
import { feeSettings, type FeeSettings } from "./settlement/fees.js";
import type { SettlementHooks } from "./settlement/hooks.js";
import {
  createReconciler,
  scheduleReconciliation,
  type Reconciliation,
} from "./settlement/reconcile.js";
import { createLeaseKeeper } from "./settlement/lease.js";
import { createRecords } from "./settlement/records.js";
import { SETTLE_MIN_VALIDITY_LEDGERS, createSettler, type Settle } from "./settlement/settle.js";
import { createTrustlineLookup } from "./settlement/trustline.js";
import {
  HORIZON_TIMEOUT_MS,
  UPSTREAM_TIMEOUT_MS,
  buildUpstream,
  failureReason,
  type UpstreamSeams,
} from "./settlement/upstream.js";
import { createAssetKinds } from "./spend/asset-kinds.js";
import { BALANCE_STALE_ALARM_MS, createBalanceFloor } from "./spend/balance-floor.js";
import { createSpendPolicy, verifyWithBreakers } from "./spend/policy.js";
import { start } from "./start.js";
import {
  createChecker,
  createVerifier,
  type Check,
  type VerifierDeps,
  type Verify,
} from "./settlement/verify.js";

/** How often the shared `FallbackRpc` probes `RPC_URLS[0]` while calls are off it (AD-3). */
export const PRIMARY_PROBE_INTERVAL_MS = 60_000;

/** How many ledgers `RPC_URLS[0]` may trail the active URL by when calls return to it (AD-3). */
export const FAILBACK_MAX_LAG_LEDGERS = 2;

/** The statement timeout of the public listings' pool, against the other pools' 10 s. */
export const DISCOVERY_STATEMENT_TIMEOUT_MS = 2_000;

/**
 * The one RPC client over `RPC_URLS` (AD-3): the pool, the AD-22 ledger read and the fee-stats bid
 * read go through it, and upstream verify shares its active URL ({@link buildUpstream}), so one
 * outage moves them all once. Each URL is named `RPC_URLS[i]#<fingerprint>` (ADR 0011); a call
 * gives up on a URL after `UPSTREAM_TIMEOUT_MS`, and calls return to `RPC_URLS[0]` after a probe
 * every `PRIMARY_PROBE_INTERVAL_MS` finds it within `FAILBACK_MAX_LAG_LEDGERS`. Logs, each with
 * `component: "rpc"` and the network: `rpc_failover` (warn) on a switch, with `by`, the method or
 * caller that saw the failure; `rpc_failback` (info) on the return; `rpc_probe_failed` (warn).
 * `makeRpc` and `timeoutMs` are test seams: the client of one URL, and how long a call may take on
 * it.
 */
export function buildRpc(
  config: Config,
  logger: Pick<Logger, "warn" | "info">,
  makeRpc: (url: string) => SorobanRpc = (url) =>
    new stellarRpc.Server(url, { allowHttp: url.startsWith("http:") }),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): FallbackRpc {
  const fields = { component: "rpc", network: config.network };
  return new FallbackRpc(
    config.rpcUrls.map((url, i) => ({ name: rpcEndpointName(url, i), rpc: makeRpc(url) })),
    {
      timeoutMs,
      failback: { intervalMs: PRIMARY_PROBE_INTERVAL_MS, maxLagLedgers: FAILBACK_MAX_LAG_LEDGERS },
      onSwitch: (from, to, error, by) =>
        logger.warn("rpc_failover", { ...fields, by, from, to, reason: failureReason({ error }) }),
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
    },
  );
}

/**
 * Upstream's signer for `ExactStellarScheme`, which `/verify` uses only for the facilitator's
 * address (`@x402/stellar` 2.28.0 `exact/facilitator/index.mjs:69-104`); `/settle` signs through
 * the pool, so upstream never signs and no secret is needed here.
 */
function verifyOnlySigner(address: string): FacilitatorStellarSigner {
  const refuse = async (): Promise<never> => {
    throw new Error("upstream's scheme only verifies; the pool signs");
  };
  return { address, signAuthEntry: refuse, signTransaction: refuse };
}

/**
 * The verify checks' dependencies from the config (AD-3, AD-5, AD-10, AD-22): {@link buildUpstream},
 * the channels and the validity minimum. `/verify` and `/settle` build their checks from the same
 * object. `fees` is the caller's, so the pool is built from the same `fees.pool` and shares its
 * bid.
 */
export function buildChecks(
  config: Config,
  rpc: Pick<
    FallbackRpc,
    "getLatestLedger" | "begin" | "markFailed" | "simulateTransaction" | "getLedgerEntries"
  >,
  fees: FeeSettings,
  logger: Pick<Logger, "warn" | "info">,
  seams?: UpstreamSeams,
): VerifierDeps {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createChecker`'s check (AD-5).
  const facilitator = verifyOnlySigner(config.signer.address);
  return {
    network: config.network,
    ...buildUpstream(config, fees, logger, facilitator, rpc, seams),
    facilitator: facilitator.address,
    channels: config.channels,
    minValidityLedgers: config.settlement.minValidityLedgers,
    maxValidityLedgers: config.settlement.maxValidityLedgers,
    latestLedger: async () => (await rpc.getLatestLedger()).sequence,
    missingTrustline: createTrustlineLookup(rpc, config.network, logger),
  };
}

/**
 * A test seam: `/verify`'s verifier on checks of its own, {@link buildChecks} through
 * `createVerifier`. `main()` builds the verifier from the checks it shares with `/settle`.
 */
export function buildVerifier(
  config: Config,
  rpc: Parameters<typeof buildChecks>[1],
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
 * The pool's events go to the metrics; its `resolved` event finishes the record of a settlement
 * answered `pending`. Reconciliation (0019) shares the settler's record writes.
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
    metrics: NetworkMetrics;
    /** The facilitator key's signer. */
    signer: TransactionSigner;
    /** Tests pass the pool's `sleep`. */
    sleep?: (ms: number) => Promise<void>;
    /** The channel lease this process holds, with its token, checked before each send (0025, 0071). */
    lease: () => LeaseFence | undefined;
  },
): {
  settle: Settle;
  submitter: SettlementSubmitter;
  reconciliation: Reconciliation;
  drain: () => Promise<void>;
} {
  const { logger, metrics } = deps;
  const network = config.network;
  const records = createRecords({ network, store: deps.store, hooks: deps.hooks, logger, metrics });
  const reconciler = createReconciler({
    network,
    store: deps.store,
    rpc: deps.rpc,
    records,
    logger,
    metrics,
    budgetMs: config.settlement.settleBudgetMs,
  });
  // The only sender of transactions in the service (AD-2). `main()` checks its channels before
  // it starts, and `/settle` reaches it only while the process holds the lease (0025).
  const submitter = new SettlementSubmitter({
    rpc: deps.rpc,
    networkPassphrase: getNetworkPassphrase(config.network),
    signer: deps.signer,
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
          network,
          transaction: event.result.hash,
          status: event.result.status,
        });
        // A store that fails here leaves the record to the next sweep.
        reconciler.resolved(event.result).catch((error: unknown) => {
          logger.warn("settlement_resolve_failed", {
            network,
            transaction: event.result.hash,
            error,
          });
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
    latestLedger: deps.checks.latestLedger,
    records,
    lease: deps.lease,
  });
  const reconciliation = scheduleReconciliation({ reconciler, logger, metrics, network });
  // Gauges read at each sample, from memory only (0027 AD-5): `stats()` copies the pool's
  // counters and load, and the reconciler's age is taken at the read.
  metrics.registerGauge("pool_queued", () => {
    const { queued, channels, busy } = submitter.stats();
    return { value: queued, labels: { channels, busy } };
  });
  metrics.registerGauge("pool_quarantined", () => ({ value: submitter.stats().quarantined }));
  metrics.registerGauge("settlement_oldest_open_seconds", () => {
    const value = reconciler.oldestOpenSeconds();
    return value === undefined ? undefined : { value };
  });
  // Closing the pool first refuses every call that sent nothing, so their records close too.
  const drain = async () => {
    await submitter.close();
    await settle.drain();
  };
  return { settle, submitter, reconciliation, drain };
}

/**
 * Every part `main()` serves, built from the config on the given stores: the cataloger, one RPC
 * and one fee configuration shared by `/verify`, `/settle` and the pool. `main()` passes the
 * PostgreSQL stores and the EMF writer; tests pass their own `rpc`, `makeScheme`, pool `sleep`
 * and `metrics` (in memory by default).
 *
 * Metrics follow each one's catalog `scope` (0027 AD-3): every part of this network (settlement,
 * records, reconciliation, the pool, the lease, the spend lane, the balance floor, the signer)
 * writes through one child scoped to `config.network`; the cataloger, discovery and the HTTP app
 * write through the root, as does the pruner `main()` builds on the returned `metrics`.
 */
export function compose(
  config: Config,
  opts: {
    logger: Logger;
    stores: AppDeps["stores"];
    rpc?: SorobanRpc;
    seams?: UpstreamSeams;
    sleep?: (ms: number) => Promise<void>;
    metrics?: ProcessMetrics;
  },
): {
  deps: AppDeps;
  cataloger: Cataloger;
  /** The root: for the process-scoped parts `main()` builds. */
  metrics: ProcessMetrics;
  rpc: FallbackRpc;
  signer: OpenBaoSigner;
  /** Unstarted: `main()` starts it with the process and stops it before the final flush. */
  rpcStall: RpcStallTracker;
} {
  const { logger } = opts;
  const { stores } = opts;
  const root = opts.metrics ?? memoryMetrics();
  // One child per network; a root write of a network-scoped metric would carry no `network`, so
  // the root's type doesn't take one.
  const metrics = root.for({ network: config.network });
  // Cataloging plugs into `/settle` through `extensionResponses` and `onSuccess` (AD-8). The
  // catalog's rows serve every network, so it writes through the root.
  const cataloger = createCataloger({
    store: stores.catalog,
    attempts: stores.catalogAttempts,
    rateLimits: stores.rateLimits,
    logger,
    metrics: root,
    listLocal: config.catalog.listLocal,
  });
  // One client for every RPC_URLS read and send, whose active URL upstream verify shares (AD-3).
  // A test's `rpc` serves every URL.
  const rpc = buildRpc(config, logger, opts.rpc && (() => opts.rpc!));
  // 1 while calls are off `RPC_URLS[0]` (0027 AD-5). `active` is a plain read; `begin()` could
  // start a probe. The label is the endpoint's name, as `buildRpc` names it, never its URL.
  const primary = rpcEndpointName(config.rpcUrls[0]!, 0);
  metrics.registerGauge("rpc_on_fallback", () => {
    const active = rpc.active;
    return { value: active === primary ? 0 : 1, labels: { rpc: active } };
  });
  // The time since the ledger sequence last changed, on the client settlement uses (0027 AD-5).
  // The poll's own reads may move `active`; that is what settlement would see.
  const rpcStall = createRpcStallTracker({ rpc, now: Date.now });
  metrics.registerGauge("rpc_stalled_seconds", () => ({ value: rpcStall.stalledSeconds() }));
  // One fee configuration: `/verify` and `/settle` check with it, and the pool pays with it, so
  // they share one ceiling and one bid (AD-10).
  const fees = feeSettings(config.fees, rpc);
  const checks = buildChecks(config, rpc, fees, logger, opts.seams);
  const signer = openBaoSigner({ ...config.signer, network: config.network, logger, metrics });
  // One lease per network's channel set (AD-17): only its holder settles.
  const lease = createLeaseKeeper({
    store: stores.settlements,
    network: config.network,
    ttlMs: config.settlement.leaseTtlMs,
    logger,
    metrics,
  });
  // The spend lane (AD-18, 0024): before a submit, the fee account's balance floor, the breakers
  // and the fee budgets; once a record is final, the fee charged and the breakers' counts. The fee
  // account is the facilitator's key, which signs every fee bump.
  const floor = createBalanceFloor({
    rpc,
    account: checks.facilitator,
    floorStroops: config.spend.floorStroops,
    intervalMs: config.spend.balanceIntervalMs,
    logger,
    metrics,
  });
  metrics.registerGauge("balance_reading_age_seconds", () => ({
    value: floor.readingAgeMs() / 1000,
  }));
  // The `balance-stale` alarm fires above 300 s, the floor's bound at the default interval; with
  // another bound it fires before `/settle` fails closed, or after.
  if (floor.maxStaleMs !== BALANCE_STALE_ALARM_MS) {
    logger.warn("balance_stale_threshold_mismatch", {
      network: config.network,
      maxStaleMs: floor.maxStaleMs,
      alarmThresholdMs: BALANCE_STALE_ALARM_MS,
    });
  }
  const policy = createSpendPolicy({
    store: stores.spend,
    // USDC is the known asset (the high tier); every other token, SAC or wasm, gets the low one.
    assets: createAssetKinds({ rpc, known: [getUsdcAddress(config.network)] }),
    floor,
    budgets: {
      windowMs: config.spend.windowMs,
      globalStroops: config.spend.globalStroops,
      perPayerStroops: config.spend.perPayerStroops,
      perPayToStroops: config.spend.perPayToStroops,
      perKnownAssetStroops: config.spend.perAssetStroops,
      perOtherAssetStroops: config.spend.perOtherAssetStroops,
      tierOtherStroops: config.spend.tierOtherStroops,
    },
    logger,
    metrics,
  });
  const { settle, reconciliation, drain } = buildSettlement(config, {
    rpc,
    fees,
    checks,
    store: stores.settlements,
    hooks: {
      beforeSubmit: policy.beforeSubmit,
      onFinal: policy.onFinal,
      onSuccess: cataloger.onSuccess,
    },
    logger,
    metrics,
    signer,
    ...(opts.sleep && { sleep: opts.sleep }),
    lease: lease.current,
  });
  return {
    deps: {
      config,
      logger,
      // The HTTP app and discovery: a route serves every network.
      metrics: root,
      stores,
      verify: verifyWithBreakers(createVerifier(checks), { policy, logger, metrics }),
      settle,
      extensionResponses: cataloger.extensionResponses,
      supported: supportedResponse(config.network, checks.facilitator),
      reconciliation,
      lease,
      floor,
      drain,
      signerState: signer.state,
    },
    cataloger,
    metrics: root,
    rpc,
    signer,
    rpcStall,
  };
}

export interface MainOptions {
  /**
   * Where the log lines and the EMF metric lines go, each ending in a newline; stdout by default.
   * The smoke scripts read them here.
   */
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
  let pools:
    { main: pg.Pool; reserve: pg.Pool; rateLimits: pg.Pool; discovery: pg.Pool } | undefined;
  const endPools = () => Promise.all(Object.values(pools ?? {}).map((p) => p.end()));
  let rpcStall: RpcStallTracker | undefined;
  /** The EMF writer, for the catch: a start that failed stops it. */
  let emf: ReturnType<typeof emfMetrics> | undefined;
  try {
    // stellar-sdk's RPC and Horizon clients use the global fetch with no timeout of their own, and
    // an upstream call cut off by its deadline can't be cancelled. undici's defaults would hold its
    // socket for 300 s; these end it after 10 s without headers or body data. Process-wide: any
    // other `fetch` in this process gets the same bounds (the facilitator makes no other).
    // Horizon gets 2 s: upstream verify reads it on every payment, with no timeout of its own, and
    // a hung one would take every RPC URL past its 10 s. Past 2 s upstream assumes 5 s a ledger.
    setGlobalDispatcher(
      boundedAgent(UPSTREAM_TIMEOUT_MS, {
        [new URL(DEFAULT_TESTNET_HORIZON_URL).origin]: HORIZON_TIMEOUT_MS,
        [new URL(DEFAULT_PUBNET_HORIZON_URL).origin]: HORIZON_TIMEOUT_MS,
      }),
    );
    // The stores need a migrated schema (`pnpm migrate`); the service never migrates it.
    // Reservations queue on the global scope's lock, a flood's hits on its key's row lock, and a
    // burst of public listings on the pool itself; their own pools keep those off the others.
    // A listing takes milliseconds (at most ~0.5 s measured at 1 000 000 entries), so the
    // discovery pool cuts one off sooner: until 0023's rate limits, 3 slow ones hold it.
    const url = config.databaseUrl;
    pools = {
      main: createPool(url, poolErrorLogger(logger)),
      reserve: createPool(url, poolErrorLogger(logger), 3),
      rateLimits: createPool(url, poolErrorLogger(logger), 3),
      discovery: createPool(url, poolErrorLogger(logger), 3, DISCOVERY_STATEMENT_TIMEOUT_MS),
    };
    // Every migration this code knows, applied by the deploy before it starts (ADR 0011). A schema
    // ahead of the code passes, so a rollback to an earlier image starts.
    const pending = await pendingMigrations(pools.main);
    if (pending.length > 0) throw new Error(`the schema lacks migrations: ${pending.join(", ")}`);
    // Every RPC_URLS entry must serve NETWORK: another network's RPC reads every channel as
    // missing. Checked first, so a wrong URL is named instead of every channel.
    await checkRpcNetworks(config.rpcUrls, getNetworkPassphrase(config.network));
    const stores = postgresStores(pools.main, pools);
    // The EMF writer (0027 AD-4) on its own sink, never through the logger. Its timers start
    // with the graph's gauges, so a startup that hangs still writes them; its liveness seed waits
    // for `start()` below. On stdout by default, where each write is awaited by the final flush.
    const { write } = opts;
    const metrics = (emf = emfMetrics({
      ...(write && { write: (line: string) => write(`${line}\n`) }),
      onIssue: (issue) => logger.warn("metric_issue", { ...issue }),
    }));
    const composed = compose(config, { logger, stores, metrics });
    const { deps, cataloger, rpc, signer } = composed;
    // With the graph, like the writer's timers: an RPC that hangs the startup checks shows as a
    // rising `rpc_stalled_seconds`.
    rpcStall = composed.rpcStall;
    rpcStall.start();
    // AD-12: the service starts only when no other key can move a channel. An RPC that doesn't
    // answer fails the check with its error. `compose()` only wires parts, so nothing has called
    // the RPC yet.
    await checkChannels(rpc, config.channels, config.signer.address);
    // For the life of the process: an upstream call cut off by the deadline keeps running after
    // `close()`, and its error would reach stderr with the RPC URL in it.
    const restoreConsole = captureConsoleError(logger, config.rpcUrls);
    const started = await start(deps).catch((error: unknown) => {
      restoreConsole();
      throw error;
    });
    // The liveness point `facilitator-silent` reads, from the service's start on (AD-4): a start
    // that hangs or fails, a crash loop of them included, writes none and shows as missing data.
    metrics.seedZero([
      { name: "settlement_sweeps_total", labels: { network: config.network, outcome: "listed" } },
    ]);
    // Not awaited: the service starts and `/verify` answers without OpenBao; the outcome goes to
    // the log and `/health`'s `signer`, and a failed check tries again (0036 decision 4).
    void signer.check();
    // Every budget sums the one window (0024 S-design §5).
    const pruner = createPruner({
      spend: stores.spend,
      rateLimits: stores.rateLimits,
      catalogAttempts: stores.catalogAttempts,
      spendWindowMs: config.spend.windowMs,
      rateLimitWindowMs: config.http.rateLimit.windowMs,
      logger,
      metrics,
    });
    pruner.start();
    // Catalog writes and a prune already under way finish before the process exits, and before
    // the pools end, even if closing the server fails; the pools end even if draining fails.
    // The metrics' final flush comes last, after every part that counts, and is awaited:
    // `server.ts` exits once this resolves, and a write to a stdout pipe is asynchronous.
    const closeOnce = async () => {
      signer.close();
      try {
        try {
          await started.close();
        } finally {
          try {
            await Promise.all([cataloger.drain(), pruner.close()]);
          } finally {
            await endPools();
          }
        }
      } finally {
        // Its last reading goes out with the final flush; no read starts after it.
        rpcStall?.stop();
        await metrics.close();
      }
    };
    let closing: Promise<void> | undefined;
    return {
      ...started,
      /** The graph's stores and their pools: for tests. */
      stores,
      pools,
      /** For tests, which run a tick instead of waiting a minute. */
      pruner,
      /** The logger every part writes to: for tests. */
      logger,
      /** Settles once the first sweep has ended: for tests. */
      reconciled: deps.reconciliation?.reconciled ?? Promise.resolve(),
      // A second signal (SIGINT after SIGTERM) gets the first call's promise: running it again
      // would end the pools under requests the first is still waiting for.
      close: () => (closing ??= closeOnce()),
    };
  } catch (error) {
    // Logged here, where an RPC URL is named as its `RPC_URLS` entry, never by its host
    // (ADR 0011); `server.ts` logs only a `ConfigError`, which comes before the logger.
    logger.error("startup_failed", { error });
    // No final metrics flush: the writer stops with its open window unwritten, so a start that
    // failed adds no point after the error. It wrote no seed either (above), so a crash loop
    // shows as missing data. Eager-first lines are out already.
    emf?.stop();
    rpcStall?.stop();
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
    const applied = await migrate(pool, Date.now(), MIGRATIONS, { logger });
    logger.info("migrated", { applied });
  } finally {
    await pool.end();
  }
}
