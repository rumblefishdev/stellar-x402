import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { RateLimitStore, SpendStore } from "./ports/index.js";

const DAY_MS = 86_400_000;
const INTERVAL_MS = 60_000;
const BATCH = 1_000;
/** Per table and tick. A count cap fell behind a flood of 20 000 new keys a minute (0050, E11). */
const BUDGET_MS = 1_000;

/**
 * How long spend reservations are kept: twice the window, and at least 7 days. A pruned
 * reservation counts against nothing, so the margin covers a window raised later (a 1-day window
 * raised to 3 days counted 36% of the new window's spend with a 25-hour horizon, 0050 E10a), a
 * late commit after an outage, and the clocks of other processes. Only disk pays for it: the sum
 * reads the window's index entries alone.
 */
export const spendHorizonMs = (windowMs: number) => Math.max(2 * windowMs, 7 * DAY_MS);

export interface PrunerDeps {
  spend: Pick<SpendStore, "prune">;
  rateLimits: Pick<RateLimitStore, "prune">;
  /** The longest window any spend budget sums. */
  spendWindowMs: number;
  rateLimitWindowMs: number;
  logger: Logger;
  metrics: Metrics;
  /** The app clock the cutoffs come from, as for every stored time. */
  now?: () => number;
  /** Elapsed time for the budget. */
  clock?: () => number;
  /** Spreads the ticks of several processes. */
  random?: () => number;
}

export interface Pruner {
  /** Ticks every minute, ±10%, until `close()`; the timer keeps no process alive. */
  start(): void;
  /** One tick: each table in batches until one comes back short or its budget runs out. */
  runOnce(): Promise<void>;
  /** Stops the timer and waits for a tick under way, so the pools can end after it. */
  close(): Promise<void>;
}

/**
 * Deletes spend reservations and rate-limit windows no budget or limit counts any more (0050).
 * Every process runs one: the deletes skip rows another holds, so pruners never wait on each
 * other or on a request, and a pruner that stops costs disk, not latency. A failure is logged
 * and counted, and the next tick tries again.
 */
export function createPruner(deps: PrunerDeps): Pruner {
  const {
    logger,
    metrics,
    now = Date.now,
    clock = () => performance.now(),
    random = Math.random,
  } = deps;
  const tables = [
    {
      table: "spend_reservations",
      store: deps.spend,
      horizonMs: spendHorizonMs(deps.spendWindowMs),
    },
    // A window that ended a window ago: a hit from a clock that lags by less still finds it.
    { table: "rate_limits", store: deps.rateLimits, horizonMs: deps.rateLimitWindowMs },
  ];

  const pruneTable = async ({ table, store, horizonMs }: (typeof tables)[number]) => {
    const before = now() - horizonMs;
    const started = clock();
    let rows = 0;
    let complete = false;
    try {
      for (;;) {
        const pruned = await store.prune(before, BATCH);
        rows += pruned;
        if (pruned < BATCH) {
          complete = true;
          break;
        }
        if (clock() - started >= BUDGET_MS) break;
      }
    } catch (error) {
      logger.warn("store_prune_failed", { table, error });
      metrics.increment("store_prune_failures_total", { table });
      return;
    }
    // `complete: false` on every tick means the table grows faster than one budget deletes.
    if (rows > 0) logger.info("store_pruned", { table, rows, complete });
  };

  const runOnce = async () => {
    for (const table of tables) await pruneTable(table);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(
      () => {
        running = runOnce().finally(() => {
          running = undefined;
          schedule();
        });
      },
      INTERVAL_MS * (0.9 + 0.2 * random()),
    );
    timer.unref();
  };

  return {
    start: schedule,
    runOnce,
    async close() {
      closed = true;
      clearTimeout(timer);
      await running;
    },
  };
}
