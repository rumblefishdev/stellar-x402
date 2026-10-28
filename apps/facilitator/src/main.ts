import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair, rpc as stellarRpc } from "@stellar/stellar-sdk";
import {
  FallbackRpc,
  RpcTimeoutError,
  SettlementSubmitter,
  keypairSigner,
  type SorobanRpc,
} from "@stellar-x402/signer-pool";
import { createEd25519Signer, getNetworkPassphrase } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type pg from "pg";
import { Agent, setGlobalDispatcher } from "undici";
import { MIGRATIONS, migrate } from "./adapters/postgres-schema.js";
import { createPool, postgresStores } from "./adapters/postgres.js";
import { createCataloger, type Cataloger } from "./catalog/cataloger.js";
import { parseConfig, parseMigrateConfig } from "./config.js";
import type { Config } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { supportedResponse } from "./http/supported.js";
import { captureConsoleError, jsonLogger, rpcEndpointName, type Logger } from "./logger.js";
import { memoryMetrics, type Metrics } from "./metrics.js";
import type { SettlementStore } from "./ports/index.js";
import { createPruner } from "./pruner.js";
import { checkChannels } from "./settlement/channel-check.js";
import { checkRpcNetworks } from "./settlement/network-check.js";
import { atCurrentBid, feeSettings, type FeeSettings } from "./settlement/fees.js";
import type { SettlementHooks } from "./settlement/hooks.js";
import {
  createReconciler,
  scheduleReconciliation,
  type Reconciliation,
} from "./settlement/reconcile.js";
import { createLeaseKeeper } from "./settlement/lease.js";
import { createRecords } from "./settlement/records.js";
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

/**
 * How long `close()` waits for the drain after SIGTERM (0025 decision 11): Docker kills the
 * container at 180 s, which leaves 30 s for the cataloger, the pruner and the pools.
 */
export const SHUTDOWN_DEADLINE_MS = 150_000;

/**
 * How long requests still open after the drain may take before their connections are cut, within
 * the deadline: a `/verify` on one RPC URL fits, and a stalled client no longer holds the process
 * past it (0025 decision 23).
 */
export const SHUTDOWN_GRACE_MS = 15_000;

/** Starts the HTTP server on the graph `deps`. Tests call it with their own config and stores. */
export async function start(
  deps: AppDeps,
  opts: { shutdownDeadlineMs?: number; shutdownGraceMs?: number } = {},
): Promise<Started> {
  const { shutdownDeadlineMs = SHUTDOWN_DEADLINE_MS, shutdownGraceMs = SHUTDOWN_GRACE_MS } = opts;
  let closing = false;
  const server = createApp({ ...deps, closing: () => closing }).listen(deps.config.port);
  await once(server, "listening");
  // After listening, so `/verify` and `/supported` answer meanwhile. Sweeps run with or without the lease (0019
  // decision 37); `/settle` serves beside them (0019 decision 27) once the lease is held, and the
  // keeper keeps trying when it isn't (0025 decision 1).
  await deps.lease?.start();
  deps.reconciliation?.start();
  const { port } = server.address() as AddressInfo;
  deps.logger.info("listening", {
    port,
    network: deps.config.network,
    channels: deps.config.channels.length,
  });
  return {
    port,
    // The shutdown (0025): `/settle` answers 503 at once, the pool refuses every call that sent
    // nothing, and calls already sent run on while the keeper keeps renewing the lease (decision
    // 10). Once they and their record writes are done nothing can send, so the lease is given up
    // and the next process takes over within one attempt (decision 23). Until then the server
    // listens, so a new `/settle` still gets its 503 rather than a refused connection. Then it
    // closes: open requests get the grace, their connections are cut, and a sweep under way is
    // waited for, as sweeps need no lease (0019 decision 37). Past the deadline the open
    // connections are cut, and a drain still under way leaves the lease to its TTL, so a
    // transaction still unresolved gets that long before another process sends on its channel
    // (decision 11).
    close: async () => {
      closing = true;
      const begun = Date.now();
      deps.logger.info("shutdown_started", { network: deps.config.network });
      // No new sweep starts; one under way is drained like the submissions, so its writes don't
      // reach the pools `main()` ends next.
      const swept = deps.reconciliation?.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), shutdownDeadlineMs);
        timer.unref();
      });
      const drained = (async () => {
        await deps.drain?.();
        return "drained" as const;
      })();
      let closed: Promise<void> | undefined;
      try {
        if ((await Promise.race([drained, deadline])) === "drained") {
          deps.logger.info("shutdown_drained", { ms: Date.now() - begun });
          await deps.lease?.release();
          closed = new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve())),
          );
          server.closeIdleConnections();
          const graced = new Promise<void>((resolve) => {
            grace = setTimeout(resolve, shutdownGraceMs);
            grace.unref();
          });
          await Promise.race([closed, graced, deadline]);
          server.closeAllConnections();
          const done = Promise.all([closed, swept]).then(() => "closed" as const);
          if ((await Promise.race([done, deadline])) === "closed") return;
          // Only a sweep is still under way: its record writes may fail once the pools end.
          deps.logger.warn("shutdown_deadline", { ms: Date.now() - begun, drained: true });
          return;
        }
        deps.logger.warn("shutdown_deadline", { ms: Date.now() - begun, drained: false });
        server.close();
        server.closeAllConnections();
        await deps.lease?.close();
      } catch (error) {
        // The server failed to close; if the drain didn't end either, the lease waits out its TTL.
        await deps.lease?.close();
        throw error;
      } finally {
        clearTimeout(timer);
        clearTimeout(grace);
        // Past the deadline the drain may still fail, or the late `server.close()` may.
        drained.catch(() => {});
        closed?.catch(() => {});
      }
    },
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

/** How often the shared `FallbackRpc` probes `RPC_URLS[0]` while calls are off it (AD-3). */
export const PRIMARY_PROBE_INTERVAL_MS = 60_000;

/** How many ledgers `RPC_URLS[0]` may trail the active URL by when calls return to it (AD-3). */
export const FAILBACK_MAX_LAG_LEDGERS = 2;

/** The statement timeout of the public listings' pool, against the other pools' 10 s. */
export const DISCOVERY_STATEMENT_TIMEOUT_MS = 2_000;

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
 * Test seams of {@link buildUpstream}: the scheme per URL, and how long one URL may take
 * (`UPSTREAM_TIMEOUT_MS` by default), so a hung URL needn't cost a test 10 s.
 */
export interface UpstreamSeams {
  makeScheme?: MakeScheme;
  timeoutMs?: number;
}

/** A short, URL-free reason for the logs: an error's message can carry an RPC URL. */
export function failureReason(failure: EndpointFailure | { error: unknown }): string {
  if ("answer" in failure) return UNEXPECTED_VERIFY_ERROR;
  const { error } = failure;
  if (error instanceof UpstreamTimeoutError || error instanceof RpcTimeoutError) return "timeout";
  return error instanceof Error ? `error:${error.name}` : "error";
}

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
 * Upstream verify from the config, with its deadline (AD-3, AD-10): one `ExactStellarScheme` per
 * `RPC_URLS` entry, with the fee ceiling and the fee a settlement pays at the shared bid, read once
 * per call, behind `failoverUpstream`, which starts each call on `active`'s URL (the shared
 * {@link buildRpc}) and reports a throw or a timeout there. Logs `rpc_exhausted` (warn, with
 * `component: "verify"`, the network and `RPC_URLS[i]#…` names) when every URL failed; switches
 * are `active`'s to log.
 * The two belong together: spread both into `VerifierDeps`, or the deadline falls back to 10 s and
 * cuts off the second URL.
 */
export function buildUpstream(
  config: Config,
  fees: FeeSettings,
  logger: Pick<Logger, "warn">,
  facilitator: ReturnType<typeof createEd25519Signer>,
  active: Pick<FallbackRpc, "begin" | "markFailed">,
  seams: UpstreamSeams = {},
): Pick<VerifierDeps, "upstream" | "upstreamTimeoutMs"> {
  const {
    makeScheme = (signer, options) => new ExactStellarScheme([signer], options),
    timeoutMs = UPSTREAM_TIMEOUT_MS,
  } = seams;
  // `RPC_URLS[i]#<fingerprint>`, as everywhere else in the logs (ADR 0011, 0009 decision 47).
  const name = (i: number) => rpcEndpointName(config.rpcUrls[i]!, i);
  // Upstream reads one RPC URL, so there is one scheme per URL, in `RPC_URLS` order: the order of
  // `active`'s endpoints.
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
  return {
    upstream: failoverUpstream(endpoints, {
      timeoutMs,
      active,
      onExhausted: (tried) =>
        logger.warn("rpc_exhausted", {
          component: "verify",
          network: config.network,
          tried: tried.map((t) => ({ rpc: t.name, reason: failureReason(t.failure) })),
        }),
    }),
    upstreamTimeoutMs: upstreamDeadlineMs(config.rpcUrls.length, fees.feeStats, timeoutMs),
  };
}

/**
 * The verify checks' dependencies from the config (AD-3, AD-5, AD-10, AD-22): {@link buildUpstream},
 * the channels and the validity minimum. `/verify` and `/settle` build their checks from the same
 * object. `fees` is the caller's, so the pool is built from the same `fees.pool` and shares its
 * bid.
 */
export function buildChecks(
  config: Config,
  rpc: Pick<FallbackRpc, "getLatestLedger" | "begin" | "markFailed">,
  fees: FeeSettings,
  logger: Pick<Logger, "warn" | "info">,
  seams?: UpstreamSeams,
): VerifierDeps {
  // Upstream knows only the facilitator key, and only in plain form; the channels and the muxed
  // facilitator are `createChecker`'s check (AD-5).
  const facilitator = createEd25519Signer(config.facilitatorSecret, config.network);
  return {
    network: config.network,
    ...buildUpstream(config, fees, logger, facilitator, rpc, seams),
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
  rpc: Pick<FallbackRpc, "getLatestLedger" | "begin" | "markFailed">,
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
    metrics: Metrics;
    /** Tests pass the pool's `sleep`. */
    sleep?: (ms: number) => Promise<void>;
    /** The channel lease's `held()`, checked again before each send (0025). */
    held?: () => boolean;
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
    records,
    ...(deps.held && { held: deps.held }),
  });
  const reconciliation = scheduleReconciliation({ reconciler, logger, network });
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
 * PostgreSQL stores; tests pass their own `rpc`, `makeScheme` and pool `sleep`.
 */
export function compose(
  config: Config,
  opts: {
    logger: Logger;
    stores: AppDeps["stores"];
    rpc?: SorobanRpc;
    seams?: UpstreamSeams;
    sleep?: (ms: number) => Promise<void>;
  },
): { deps: AppDeps; cataloger: Cataloger; metrics: Metrics; rpc: FallbackRpc } {
  const { logger } = opts;
  const { stores } = opts;
  // Cataloging plugs into `/settle` through `extensionResponses` and `onSuccess` (AD-8).
  const metrics = memoryMetrics();
  const cataloger = createCataloger({
    store: stores.catalog,
    attempts: stores.catalogAttempts,
    rateLimits: stores.rateLimits,
    logger,
    metrics,
    listLocal: config.catalog.listLocal,
  });
  // One client for every RPC_URLS read and send, whose active URL upstream verify shares (AD-3).
  // A test's `rpc` serves every URL.
  const rpc = buildRpc(config, logger, opts.rpc && (() => opts.rpc!));
  // One fee configuration: `/verify` and `/settle` check with it, and the pool pays with it, so
  // they share one ceiling and one bid (AD-10).
  const fees = feeSettings(config.fees, rpc);
  const checks = buildChecks(config, rpc, fees, logger, opts.seams);
  // One lease per network's channel set (AD-17): only its holder settles.
  const lease = createLeaseKeeper({
    store: stores.settlements,
    network: config.network,
    ttlMs: config.settlement.leaseTtlMs,
    logger,
    metrics,
  });
  const { settle, reconciliation, drain } = buildSettlement(config, {
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
    held: lease.held,
  });
  return {
    deps: {
      config,
      logger,
      metrics,
      stores,
      verify: createVerifier(checks),
      settle,
      extensionResponses: cataloger.extensionResponses,
      supported: supportedResponse(config.network, checks.facilitator),
      reconciliation,
      lease,
      drain,
    },
    cataloger,
    metrics,
    rpc,
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
  let pools:
    { main: pg.Pool; reserve: pg.Pool; rateLimits: pg.Pool; discovery: pg.Pool } | undefined;
  const endPools = () => Promise.all(Object.values(pools ?? {}).map((p) => p.end()));
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
    // Every RPC_URLS entry must serve NETWORK: another network's RPC reads every channel as
    // missing. Checked first, so a wrong URL is named instead of every channel.
    await checkRpcNetworks(config.rpcUrls, getNetworkPassphrase(config.network));
    const stores = postgresStores(pools.main, pools);
    const { deps, cataloger, metrics, rpc } = compose(config, { logger, stores });
    // AD-12: the service starts only when no other key can move a channel. An RPC that doesn't
    // answer fails the check with its error. `compose()` only wires parts, so nothing has called
    // the RPC yet.
    const facilitator = Keypair.fromSecret(config.facilitatorSecret).publicKey();
    await checkChannels(rpc, config.channels, facilitator);
    // For the life of the process: an upstream call cut off by the deadline keeps running after
    // `close()`, and its error would reach stderr with the RPC URL in it.
    const restoreConsole = captureConsoleError(logger, config.rpcUrls);
    const started = await start(deps).catch((error: unknown) => {
      restoreConsole();
      throw error;
    });
    // One window today; with per-budget windows (0024), the longest of them.
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
    const closeOnce = async () => {
      try {
        await started.close();
      } finally {
        try {
          await Promise.all([cataloger.drain(), pruner.close()]);
        } finally {
          await endPools();
        }
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
