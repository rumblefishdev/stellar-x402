import {
  checkFacilitatorBalance,
  type BalanceReport,
  type SorobanRpc,
} from "@stellar-x402/signer-pool";
import type { Logger } from "../logger.js";
import type { NetworkMetrics } from "../metrics.js";
import type { BalanceFloor } from "./policy.js";

/**
 * The age above which the `balance-stale` alarm fires (0027 G-alarm-list): the floor's
 * `maxStaleMs` at the default 30 s interval. Startup warns when the configured bound differs.
 */
export const BALANCE_STALE_ALARM_MS = 300_000;

/** The floor as `start()` and `close()` run it: read in the background, checked in memory. */
export interface BalanceReader extends BalanceFloor {
  /** Reads the balance once, then every `intervalMs` until `stop()`; never rejects. */
  start(): Promise<void>;
  /** One read: for tests, and the first read of `start()`. */
  runOnce(): Promise<void>;
  /** Stops the timer; a read under way still finishes, and schedules none. */
  stop(): void;
  /**
   * How old the last successful reading is, at the call; before one, the time since `start()` (or
   * since the floor was built, before that). Pure: it logs nothing, unlike `below()`. The
   * `balance_reading_age_seconds` gauge (0027 AD-5).
   */
  readingAgeMs(): number;
  /** How old a reading may be before `below()` fails closed. */
  readonly maxStaleMs: number;
}

/**
 * Whether the fee account, which pays every fee bump (AD-10), can spend less than `floorStroops`
 * (S-design §8): its balance minus the reserve and the selling liabilities, which no fee can draw
 * on, as `checkFacilitatorBalance` counts it. The balance is read every `intervalMs`, so
 * `/settle` checks it without an RPC call. With no reading yet it is below (fail closed); a failed
 * read keeps the last one, so an RPC hiccup doesn't refuse every payment, until it is `maxStaleMs`
 * old: then it is below again, so a few minutes of RPC trouble refuse every `/settle` with a
 * funded account. Logs the first reading and each crossing, `facilitator_underfunded` (error) and
 * `facilitator_funded` (info), and each time the reading goes stale or a read refreshes it,
 * `facilitator_balance_stale` (error) and `facilitator_balance_fresh` (info).
 */
export function createBalanceFloor(deps: {
  rpc: Pick<SorobanRpc, "getLedgerEntries">;
  account: string;
  floorStroops: bigint;
  intervalMs: number;
  logger: Logger;
  metrics: NetworkMetrics;
  /** How stale the last reading may be before `below()` fails closed again (defaults below). */
  maxStaleMs?: number;
  now?: () => number;
}): BalanceReader {
  const { rpc, account, floorStroops, intervalMs, logger, metrics } = deps;
  const clock = deps.now ?? Date.now;
  // After one success a failed read keeps the last reading, so an RPC hiccup doesn't refuse every
  // payment; but an outage that keeps the reading stale this long fails closed, so a draining fee
  // account isn't served on a value no read has refreshed. Defaults to ten intervals, at least a
  // few minutes.
  const maxStaleMs = deps.maxStaleMs ?? Math.max(intervalMs * 10, 5 * 60_000);
  let below: boolean | undefined;
  /** When the last successful read landed; `below` is trusted only while it is fresh. */
  let lastOkAt: number | undefined;
  /** Whether `facilitator_balance_stale` was logged for the reading `lastOkAt` names. */
  let staleLogged = false;
  /** What the reading's age counts from before the first good read: `start()`, else creation. */
  let startedAt = clock();

  /** Whether a reading is there but too old to trust; logs the first time it finds so. */
  function stale(): boolean {
    if (lastOkAt === undefined) return false;
    const age = clock() - lastOkAt;
    if (age <= maxStaleMs) return false;
    if (!staleLogged) {
      staleLogged = true;
      logger.error("facilitator_balance_stale", { account, ageMs: age, maxStaleMs });
    }
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  async function runOnce() {
    let report: BalanceReport;
    try {
      report = await checkFacilitatorBalance(rpc, account);
    } catch (error) {
      metrics.increment("balance_read_failures_total");
      logger.warn("balance_read_failed", { account, error });
      stale();
      return;
    }
    lastOkAt = clock();
    if (staleLogged) {
      staleLogged = false;
      logger.info("facilitator_balance_fresh", { account });
    }
    const spendable = report.spendableStroops;
    const now = spendable < floorStroops;
    if (now === below) return;
    below = now;
    const fields = { account, balance: report.balanceStroops, spendable, floor: floorStroops };
    if (now) logger.error("facilitator_underfunded", fields);
    else logger.info("facilitator_funded", fields);
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().then(schedule);
    }, intervalMs);
    // The process may exit while the floor still reads.
    timer.unref?.();
  };

  return {
    // Below the floor itself, or failing closed: before any reading, and once the last successful
    // one is too old.
    below: () => stale() || (below ?? true) || lastOkAt === undefined,
    runOnce,
    readingAgeMs: () => Math.max(0, clock() - (lastOkAt ?? startedAt)),
    maxStaleMs,
    async start() {
      stopped = false;
      startedAt = clock();
      await runOnce();
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
