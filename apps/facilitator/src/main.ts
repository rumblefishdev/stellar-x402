import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rpc as stellarRpc } from "@stellar/stellar-sdk";
import {
  PostgresAccountPlanStore,
  apiKeyHash,
  isApiKeyOwner,
  newApiKey,
  type AccountPlan,
  type AccountPlanRecord,
} from "@stellar-x402/api-keys";
import { SEARCH_MODEL_ID } from "@stellar-x402/config";
import {
  FallbackRpc,
  SettlementSubmitter,
  type SorobanRpc,
  type TransactionSigner,
} from "@stellar-x402/signer-pool";
import { getNetworkPassphrase, getUsdcAddress, type FacilitatorStellarSigner } from "@x402/stellar";
import type pg from "pg";
import { Agent, setGlobalDispatcher } from "undici";
import { openBaoSigner, type OpenBaoSigner } from "./adapters/openbao-signer.js";
import { metricsListener, prometheusMetrics } from "./adapters/prometheus-metrics.js";
import { MIGRATIONS, migrate, pendingMigrations } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createSearchModelClient, searchModelReady } from "./adapters/search-model.js";
import { createCataloger, type Cataloger } from "./catalog/cataloger.js";
import { createSearchCardRewrite } from "./catalog/search-cards.js";
import { createSearchVectors, type SearchVectors } from "./catalog/search-vectors.js";
import { reportLines, parseHosts, seedHosts } from "./catalog/seed.js";
import {
  parseAccountPlansConfig,
  parseConfig,
  parseMigrateConfig,
  parseSeedConfig,
} from "./config.js";
import type { Config } from "./config.js";
import type { AppDeps } from "./http/app.js";
import { requiresApiKey } from "./http/api-key.js";
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
import { createChannelHolder, type ChannelHolder } from "./settlement/open-channels.js";
import { createRecords } from "./settlement/records.js";
import { SETTLE_MIN_VALIDITY_LEDGERS, createSettler, type Settle } from "./settlement/settle.js";
import { createNonceLookup } from "./settlement/nonce-used.js";
import { createTrustlineLookup } from "./settlement/trustline.js";
import {
  UPSTREAM_TIMEOUT_MS,
  buildUpstream,
  failureReason,
  type UpstreamSeams,
} from "./settlement/upstream.js";
import { createAssetKinds, type AssetKinds } from "./spend/asset-kinds.js";
import { BALANCE_STALE_ALARM_MS, createBalanceFloor } from "./spend/balance-floor.js";
import { longestSpendWindowMs } from "./spend/limits.js";
import { createSpendPolicy, verifyWithBreakers } from "./spend/policy.js";
import { verifyWithRefusals } from "./settlement/refusals.js";
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
 * address (`@x402/stellar` 2.31.0 `exact/facilitator/index.mjs:71-106`); `/settle` signs through
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
 * bid. `assets` is the spend policy's too, so the two share one cache of the tokens' kinds.
 */
export function buildChecks(
  config: Config,
  rpc: Pick<
    FallbackRpc,
    "getLatestLedger" | "begin" | "markFailed" | "simulateTransaction" | "getLedgerEntries"
  >,
  fees: FeeSettings,
  logger: Pick<Logger, "warn" | "info">,
  metrics: NetworkMetrics,
  seams?: UpstreamSeams,
): VerifierDeps & { assets: AssetKinds } {
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
    nonceUsed: createNonceLookup(rpc, config.network, logger),
    metrics,
    // USDC is the known asset (the high tier); every other token, SAC or wasm, gets the low one.
    assets: createAssetKinds({ rpc, known: [getUsdcAddress(config.network)] }),
    rpc,
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
  metrics: NetworkMetrics,
  seams?: UpstreamSeams,
): Verify {
  return createVerifier(buildChecks(config, rpc, fees, logger, metrics, seams));
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
  /** Holds back the channels a previous process left open; run when the lease is acquired (0090). */
  channelHolder: ChannelHolder;
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
    nonceUsed: deps.checks.nonceUsed,
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
    nonceUsed: deps.checks.nonceUsed,
    records,
    lease: deps.lease,
  });
  const reconciliation = scheduleReconciliation({ reconciler, logger, metrics, network });
  const channelHolder = createChannelHolder({
    store: deps.store,
    network,
    channels: config.channels,
    latestLedger: async () => {
      const latest = await deps.rpc.getLatestLedger();
      return { sequence: latest.sequence, closeTime: Number(latest.closeTime) };
    },
    hold: (address, until) => submitter.hold(address, until),
    logger,
  });
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
    channelHolder.close();
    await submitter.close();
    await settle.drain();
  };
  return { settle, submitter, reconciliation, channelHolder, drain };
}

/**
 * Every part `main()` serves, built from the config on the given stores: the cataloger, one RPC
 * and one fee configuration shared by `/verify`, `/settle` and the pool. `main()` passes the
 * PostgreSQL stores and the Prometheus writer; tests pass their own `rpc`, `makeScheme`, pool `sleep`
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
  /** Unstarted: `main()` starts the loop after the search card rewrite. */
  vectors: SearchVectors;
} {
  const { logger } = opts;
  const { stores } = opts;
  const root = opts.metrics ?? memoryMetrics();
  // One child per network; a root write of a network-scoped metric would carry no `network`, so
  // the root's type doesn't take one.
  const metrics = root.for({ network: config.network });
  // The search model (ADR 0014): the route asks it for each query's vector, the vectors for each
  // listing's. The cards serve every network, so they write through the root.
  const embedder = createSearchModelClient({ ...config.searchModel, model: SEARCH_MODEL_ID });
  const vectors = createSearchVectors({
    store: stores.searchCards,
    embedder,
    ready: () => searchModelReady(config.searchModel),
    logger,
    metrics: root,
  });
  // The model's health whether anyone searches or not (ADR 0014): each run of the vectors' loop
  // asks it, every 30 s at least. The model serves every network.
  root.registerGauge("search_model_up", () => ({ value: vectors.up() }));
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
  const checks = buildChecks(config, rpc, fees, logger, metrics, opts.seams);
  const signer = openBaoSigner({ ...config.signer, network: config.network, logger, metrics });
  // One lease per network's channel set (AD-17): only its holder settles, and only once the
  // channels the previous holder left a transaction open on are held back (0090). The holder is
  // built with the submitter below, before the keeper's first attempt.
  const late: { channelHolder?: ChannelHolder } = {};
  const lease = createLeaseKeeper({
    store: stores.settlements,
    network: config.network,
    ttlMs: config.settlement.leaseTtlMs,
    logger,
    metrics,
    onAcquired: () => late.channelHolder!.holdOpen(),
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
    assets: checks.assets,
    floor,
    budgets: {
      windowMs: config.spend.windowMs,
      globalStroops: config.spend.globalStroops,
      freeStroops: config.spend.freeStroops,
      perPayerStroops: config.spend.perPayerStroops,
      perPayToStroops: config.spend.perPayToStroops,
      perKnownAssetStroops: config.spend.perAssetStroops,
      perOtherAssetStroops: config.spend.perOtherAssetStroops,
      tierOtherStroops: config.spend.tierOtherStroops,
    },
    // On a network that requires an API key, each settlement counts in its caller's account,
    // by the plan the registry names (0107).
    plans: stores.accountPlans,
    accountPlans: config.spend.accountPlans,
    keyed: requiresApiKey(config.network),
    logger,
    metrics,
  });
  const built = buildSettlement(config, {
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
  const { settle, reconciliation, drain } = built;
  late.channelHolder = built.channelHolder;
  return {
    deps: {
      config,
      logger,
      // The HTTP app and discovery: a route serves every network.
      metrics: root,
      stores,
      // Refusals are recorded inside the breakers: only the checks' own (0086).
      verify: verifyWithBreakers(
        verifyWithRefusals(createVerifier(checks), {
          network: config.network,
          store: stores.settlements,
          logger,
          latestLedger: checks.latestLedger,
        }),
        { policy, logger, metrics },
      ),
      settle,
      extensionResponses: cataloger.extensionResponses,
      supported: supportedResponse(config.network, checks.facilitator),
      reconciliation,
      lease,
      floor,
      drain,
      signerState: signer.state,
      embedder,
    },
    cataloger,
    metrics: root,
    rpc,
    signer,
    rpcStall,
    vectors,
  };
}

export interface MainOptions {
  /** Where the log lines go, each ending in a newline; stdout by default. The smoke scripts read them here. */
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
    | { main: pg.Pool; reserve: pg.Pool; rateLimits: pg.Pool; discovery: pg.Pool; apiKeys: pg.Pool }
    | undefined;
  const endPools = () => Promise.all(Object.values(pools ?? {}).map((p) => p.end()));
  let rpcStall: RpcStallTracker | undefined;
  /** `/metrics`'s listener, for the catch: a start that failed closes it. */
  let metricsServer: Server | undefined;
  try {
    // stellar-sdk's RPC and Horizon clients use the global fetch with no timeout of their own, and
    // an upstream call cut off by its deadline can't be cancelled. undici's defaults would hold its
    // socket for 300 s; these end it after 10 s without headers or body data. Process-wide: any
    // other `fetch` in this process gets the same bounds (the facilitator makes no other).
    setGlobalDispatcher(
      new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS }),
    );
    // The stores need a migrated schema (`pnpm migrate`); the service never migrates it.
    // Reservations queue on the global scope's lock, a flood's hits on its key's row lock, and a
    // burst of public listings or of made-up API keys' registry reads on the pool itself; their
    // own pools keep those off the others.
    // A listing takes milliseconds (at most ~0.5 s measured at 1 000 000 entries), so the
    // discovery pool cuts one off sooner: until 0023's rate limits, 3 slow ones hold it.
    const url = config.databaseUrl;
    pools = {
      main: createPool(url, poolErrorLogger(logger)),
      reserve: createPool(url, poolErrorLogger(logger), 3),
      rateLimits: createPool(url, poolErrorLogger(logger), 3),
      discovery: createPool(url, poolErrorLogger(logger), 3, DISCOVERY_STATEMENT_TIMEOUT_MS),
      apiKeys: createPool(url, poolErrorLogger(logger), 3),
    };
    // Every migration this code knows, applied by the deploy before it starts (ADR 0011). A schema
    // ahead of the code passes, so a rollback to an earlier image starts.
    const pending = await pendingMigrations(pools.main);
    if (pending.length > 0) throw new Error(`the schema lacks migrations: ${pending.join(", ")}`);
    // Every RPC_URLS entry must serve NETWORK: another network's RPC reads every channel as
    // missing. Checked first, so a wrong URL is named instead of every channel.
    await checkRpcNetworks(config.rpcUrls, getNetworkPassphrase(config.network));
    const stores = postgresStores(pools.main, pools, SEARCH_MODEL_ID);
    // The metrics as Prometheus text (ADR 0011, "Metrics"; 0139), read by the agent on the server.
    // `/metrics` listens before the graph is built, so a startup that hangs still shows its
    // gauges; the liveness series waits for `start()` below.
    const metrics = prometheusMetrics({
      networks: [config.network],
      onIssue: (issue) => logger.warn("metric_issue", { ...issue }),
    });
    if (config.metricsPort !== undefined) {
      metricsServer = createServer(metricsListener(metrics.render)).listen(config.metricsPort);
      await once(metricsServer, "listening");
    }
    const composed = compose(config, { logger, stores, metrics });
    const { deps, cataloger, rpc, signer, vectors } = composed;
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
    // The liveness series `facilitator-silent` reads, from the service's start on: a start that
    // hangs or fails, a crash loop of them included, writes none.
    metrics.markStarted();
    // Not awaited: the service starts and `/verify` answers without OpenBao; the outcome goes to
    // the log and `/health`'s `signer`, and a failed check tries again (0036 decision 4).
    void signer.check();
    // Every budget sums the one window (0024 S-design §5); where a key is required, an account's
    // payments are counted from the start of its month too (0107).
    const pruner = createPruner({
      settlements: stores.settlements,
      ledger: {
        network: config.network,
        latest: async () => (await rpc.getLatestLedger()).sequence,
      },
      spend: stores.spend,
      rateLimits: stores.rateLimits,
      catalogAttempts: stores.catalogAttempts,
      spendWindowMs: longestSpendWindowMs(config.spend.windowMs, requiresApiKey(config.network)),
      rateLimitWindowMs: config.http.rateLimit.windowMs,
      logger,
      metrics,
    });
    pruner.start();
    const searchCards = createSearchCardRewrite({ store: stores.searchCards, logger, metrics });
    const searchCardsRewritten = searchCards.start();
    // After the rewrite, so each vector is made from the card's text under this release's rules.
    const searchVectorsWritten = searchCardsRewritten.then(() => vectors.start());
    // Catalog writes, a prune, the search card rewrite and the vector run already under way
    // finish before the process exits, and before the pools end, even if closing the server fails;
    // the pools end even if draining fails. `/metrics` closes last, after every part that counts,
    // so a scrape meanwhile still reads them.
    const closeOnce = async () => {
      signer.close();
      // The search card rewrite and the vectors' loop stop at once, so they hold no connection
      // through the drain. A pass that hasn't started yet then reads nothing.
      const rewriteClosed = searchCards.close();
      const vectorsClosed = vectors.close();
      try {
        try {
          await started.close();
        } finally {
          try {
            await Promise.all([cataloger.drain(), pruner.close(), rewriteClosed, vectorsClosed]);
          } finally {
            await endPools();
          }
        }
      } finally {
        rpcStall?.stop();
        await closeMetrics(metricsServer);
      }
    };
    let closing: Promise<void> | undefined;
    return {
      ...started,
      /** `/metrics`'s port when `METRICS_PORT` is set: for tests, which pass 0. */
      ...(metricsServer && { metricsPort: (metricsServer.address() as AddressInfo).port }),
      /** The graph's stores and their pools: for tests. */
      stores,
      pools,
      /** For tests, which run a tick instead of waiting a minute. */
      pruner,
      /** The logger every part writes to: for tests. */
      logger,
      /** Settles once the first sweep has ended: for tests. */
      reconciled: deps.reconciliation?.reconciled ?? Promise.resolve(),
      /** Settles once the search card rewrite at start has ended: for tests. */
      searchCardsRewritten,
      /** Settles once the vectors' first run has ended: for tests. */
      searchVectorsWritten,
      // A second signal (SIGINT after SIGTERM) gets the first call's promise: running it again
      // would end the pools under requests the first is still waiting for.
      close: () => (closing ??= closeOnce()),
    };
  } catch (error) {
    // Logged here, where an RPC URL is named as its `RPC_URLS` entry, never by its host
    // (ADR 0011); `server.ts` logs only a `ConfigError`, which comes before the logger.
    logger.error("startup_failed", { error });
    // It wrote no liveness series (above), so a crash loop shows as missing data.
    await closeMetrics(metricsServer);
    rpcStall?.stop();
    await endPools();
    throw error;
  }
}

/** Closes `/metrics`, the scraper's kept-alive connection included, which would hold `close()`. */
async function closeMetrics(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
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

/** What the operator's key script answers a mistake with: the entry point prints the message. */
export class KeysError extends Error {
  override name = "KeysError";
}

/** The key script's usage, naming the plans `plan` takes. */
const keysUsage = (plans: ReadonlyMap<string, AccountPlan>) =>
  `usage: keys issue <name> | keys revoke <name | owner> | keys list | keys plan <owner> <plan> [note…] | keys plans
  issue <name>     a new key for operator:<name>, printed once; <name> is a-z, 0-9, "_" and "-"
  revoke <owner>   revokes the owner's active key at once; a bare <name> means operator:<name>
  list             every key: owner, state, times and the start of its hash
  plan <owner> <plan> [note…]
                   sets the owner's plan, one of ${[...plans.keys()].join(", ")}; the rest of the line is why
  plans            every plan set: owner, plan, when, by whom and why`;

/** A name the operator gives a key's holder: what follows `operator:` in the owner. */
const OPERATOR_NAME = /^[a-z0-9][a-z0-9_-]*$/;

type KeysCommand =
  | { command: "issue"; owner: string }
  | { command: "revoke"; owner: string }
  | { command: "list" }
  | { command: "plan"; owner: string; plan: string; note?: string }
  | { command: "plans" };

/** The command line of the key script; anything it doesn't take is a {@link KeysError}. */
function parseKeysCommand(
  argv: readonly string[],
  plans: ReadonlyMap<string, AccountPlan>,
): KeysCommand {
  const [command, target, ...rest] = argv;
  const usage = () => new KeysError(keysUsage(plans));
  if ((command === "list" || command === "plans") && target === undefined) return { command };
  if (command === "plan") {
    // The whole owner: an account the portal made has no bare name.
    const [plan, ...words] = rest;
    if (target === undefined || !isApiKeyOwner(target) || plan === undefined || !plans.has(plan))
      throw usage();
    // On one line, so a quoted tab or line break can't split the row `plans` prints.
    const note = words.join(" ").replace(/\s+/g, " ").trim();
    return { command, owner: target, plan, ...(note.length > 0 && { note }) };
  }
  if ((command !== "issue" && command !== "revoke") || target === undefined || rest.length > 0)
    throw usage();
  // Only the portal issues an owner of another kind (0106), so `issue` takes a name alone; a
  // revocation may name any owner, as the operator revokes a leaked key whoever issued it.
  const named = OPERATOR_NAME.test(target);
  const owner = named ? `operator:${target}` : target;
  if ((command === "issue" && !named) || !isApiKeyOwner(owner)) throw usage();
  return { command, owner };
}

/** A plan row as `plan` and `plans` print it, one tab-separated line. */
function planLine(row: AccountPlanRecord): string {
  return [
    row.owner,
    row.plan,
    `set ${new Date(row.setAt).toISOString()}`,
    `by ${row.setBy}`,
    row.note ?? "-",
  ].join("\t");
}

/**
 * Who sets a plan, as its row records it: `operator:$USER`, or `operator:unknown` when the login
 * isn't a name an owner can carry. The row only records it, so no login fails the command.
 */
function planSetter(env: Record<string, string | undefined>): string {
  const setter = `operator:${env.USER ?? ""}`;
  return isApiKeyOwner(setter) ? setter : "operator:unknown";
}

/**
 * `pnpm keys`: the operator's hand on the API key registry (0105), the same one the portal
 * writes (0106), and on each account's plan (0107). It needs only `DATABASE_URL`, of the network
 * whose callers the key or the plan is for, and `ACCOUNT_PLANS` where the service has it set.
 *
 * `issue` prints the new key once, through `write` (stdout) and never through the logger: only
 * its SHA-256 is stored, so a lost key is replaced, not read back. `revoke` holds from the
 * caller's next request, on every instance. `plan` takes only a plan the config names. A mistake
 * rejects with a {@link KeysError}.
 */
export async function keysMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<void> {
  // Before the command: its usage names the plans. Run in the service's container, `ACCOUNT_PLANS`
  // is the service's own.
  const parsed = parseKeysCommand(argv, parseAccountPlansConfig(env));
  const { databaseUrl } = parseMigrateConfig(env);
  // Stdout is the operator's, so a lost connection is logged to stderr.
  const logger = jsonLogger("info", (line) => process.stderr.write(line));
  const pool = createPool(databaseUrl, poolErrorLogger(logger), 1);
  try {
    const pending = await pendingMigrations(pool);
    if (pending.length > 0)
      throw new KeysError(`the schema lacks migrations: ${pending.join(", ")}`);
    const { apiKeys } = postgresStores(pool);
    if (parsed.command === "list") {
      const keys = await apiKeys.list();
      if (keys.length === 0) write("no keys");
      const at = (ms: number) => new Date(ms).toISOString();
      for (const key of keys)
        write(
          [
            key.owner,
            key.state,
            `issued ${at(key.createdAt)}`,
            key.revokedAt === undefined ? "-" : `revoked ${at(key.revokedAt)}`,
            `sha256 ${key.hash.slice(0, 12)}`,
          ].join("\t"),
        );
      return;
    }
    const accountPlans = new PostgresAccountPlanStore(pool);
    if (parsed.command === "plans") {
      const rows = await accountPlans.listPlans();
      if (rows.length === 0) write("no plans");
      for (const row of rows) write(planLine(row));
      return;
    }
    if (parsed.command === "plan") {
      const { owner, plan, note } = parsed;
      const now = Date.now();
      const setBy = planSetter(env);
      await accountPlans.setPlan({ owner, plan, now, setBy, note });
      write(planLine({ owner, plan, setAt: now, setBy, note }));
      return;
    }
    const { owner } = parsed;
    if (parsed.command === "revoke") {
      if (!(await apiKeys.revoke(owner, Date.now())))
        throw new KeysError(`${owner} has no active key`);
      write(`revoked: ${owner}`);
      return;
    }
    const key = newApiKey();
    if (!(await apiKeys.issue({ hash: apiKeyHash(key), owner, now: Date.now() })))
      throw new KeysError(`${owner} has an active key: revoke it first`);
    write(`owner: ${owner}`);
    write(`key: ${key}`);
    write('Shown once: only its SHA-256 is stored. Sent as "Authorization: Bearer <key>".');
  } finally {
    await pool.end();
  }
}

export class SeedError extends Error {}

/**
 * The `pnpm seed <hosts file>` command (0155): seeds the catalog once from each host's own
 * `/.well-known/x402`, into the database `DATABASE_URL` names. What the operator reads goes to
 * stdout; log lines go to stderr.
 */
export async function seedMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<void> {
  const [path, ...rest] = argv;
  if (path === undefined || rest.length > 0) throw new SeedError("usage: pnpm seed <hosts file>");
  const { origins, invalid } = parseHosts(await readFile(path, "utf8"));
  if (invalid.length > 0)
    throw new SeedError(`the hosts file has lines that aren't hosts: ${invalid.join(", ")}`);
  const { databaseUrl, searchModel } = parseSeedConfig(env);
  const logger = jsonLogger("info", (line) => process.stderr.write(line));
  const pool = createPool(databaseUrl, poolErrorLogger(logger));
  try {
    const pending = await pendingMigrations(pool);
    if (pending.length > 0)
      throw new SeedError(`the schema lacks migrations: ${pending.join(", ")}`);
    const stores = postgresStores(pool, {}, SEARCH_MODEL_ID);
    const metrics = memoryMetrics();
    const vectors = createSearchVectors({
      store: stores.searchCards,
      embedder: createSearchModelClient({ ...searchModel, model: SEARCH_MODEL_ID }),
      ready: () => searchModelReady(searchModel),
      logger,
      metrics,
    });
    const cataloger = createCataloger({
      store: stores.catalog,
      attempts: stores.catalogAttempts,
      rateLimits: stores.rateLimits,
      logger,
      metrics,
    });
    const reports = await seedHosts(origins, cataloger, { listLocal: false });
    await cataloger.drain();
    // One run embeds the cards seeded; the pool ends only once their vectors are stored.
    await vectors.start();
    await vectors.close();
    for (const line of reportLines(reports)) write(line);
  } finally {
    await pool.end();
  }
}
