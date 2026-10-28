import { Transaction, rpc } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@stellar-x402/config";
import type { SorobanRpc, SubmitResult } from "@stellar-x402/signer-pool";
import { getNetworkPassphrase } from "@x402/stellar";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type {
  AttemptUpdate,
  SettlementAttempt,
  SettlementRecord,
  SettlementStore,
} from "../ports/index.js";
import { attemptUpdates, isFinalRecord, type Records } from "./records.js";
import { SETTLE_REASONS } from "./settle.js";
import { authExpiration } from "./verify.js";

export interface ReconcilerDeps {
  network: StellarNetwork;
  store: SettlementStore;
  rpc: Pick<SorobanRpc, "getTransaction">;
  /** Shared with `/settle`, so both write through one module and see one `answeredHere`. */
  records: Records;
  logger: Logger;
  metrics: Metrics;
  /** `SETTLE_BUDGET_MS`: past it plus `MARGIN_MS`, no call adds a hash to a claim. */
  budgetMs: number;
  now?: () => number;
}

/** Added to the budget before a sweep closes a claim with no hash (decision 13). */
const MARGIN_MS = 5_000;
/** Records resolved at once, so a backlog after an outage doesn't flood the RPC. */
const CONCURRENCY = 4;
/** How often a record whose hash fell out of the RPC's history is checked again (decision 27). */
const HISTORY_GONE_RECHECK_MS = 5 * 60_000;

/** What one sweep did, by the state each record ended in; `open` stayed non-final. */
export type SweepReport = Record<
  "rejected" | "success" | "failed" | "expired" | "open" | "errors",
  number
>;

type Outcome = keyof SweepReport;

/**
 * Settlement reconciliation (AD-16, 0019): finishes records a crash, a restart or a store outage
 * left non-final, from the network's answer for each of their hashes. Writes go through
 * `records`, forward-only compare-and-sets, so a sweep can run beside `/settle` and the pool's
 * `resolved` events. A hash the network doesn't know stays open until its bound has passed
 * (decision 1), and a record expires only once every hash is dead (decision 5) and no hash was
 * stored since the sweep read them (decision 26).
 */
export function createReconciler(deps: ReconcilerDeps) {
  const { network, store, records, logger, metrics, now = Date.now } = deps;

  /**
   * Finishes a record as `success` or `failed` from the hash that landed. A success the process
   * answered while the store was down is marked answered (decision 9); one it didn't stays
   * unmarked, so a repeat gets it.
   */
  const land = async (
    record: SettlementRecord,
    attempt: SettlementAttempt,
    res: rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse,
    others: AttemptUpdate[],
  ): Promise<Outcome> => {
    const success = res.status === rpc.Api.GetTransactionStatus.SUCCESS;
    const { record: finished, won } = await records.finish(
      record.key,
      {
        state: success ? "success" : "failed",
        ledger: res.ledger,
        feeCharged: res.resultXdr.feeCharged().toBigInt(),
        ...(attempt.channel !== undefined && { channel: attempt.channel }),
        ...(!success && { errorReason: SETTLE_REASONS.failed }),
        attempts: [...others, { hash: attempt.hash, state: "landed" }],
      },
      "resolved",
    );
    if (!won) return "open";
    if (success && finished) await markIfAnswered(finished);
    return success ? "success" : "failed";
  };

  /** Marks a success this process answered without the store's mark; any other stays unmarked. */
  const markAnswered = async (key: SettlementRecord["key"]) => {
    if (!records.unmarked.has(key)) return;
    await store.markSuccessAnswered(key, now());
    // Marked now, or already by a repeat: either way the store holds it.
    records.unmarked.delete(key);
    records.answeredHere.delete(key);
  };

  /** The hook runs even when the mark fails: the record is final, so no sweep comes back to it. */
  const markIfAnswered = async (record: SettlementRecord) => {
    try {
      await markAnswered(record.key);
    } finally {
      records.onSuccess(record, "resolved");
    }
  };

  /** A key a pass below couldn't check: logged, and tried again by the next sweep. */
  const keyFailed = (key: SettlementRecord["key"], error: unknown) =>
    logger.warn("settlement_reconcile_failed", { network, settlementKey: key, error });

  /**
   * Successes already stored whose mark failed: their record is final, so no sweep reads it. One
   * key at a time, so one that keeps failing doesn't stop the sweep.
   */
  const retryMarks = async () => {
    for (const key of [...records.unmarked]) {
      try {
        const record = await store.get(key);
        if (record?.state === "success") await markAnswered(key);
      } catch (error) {
        keyFailed(key, error);
      }
    }
  };

  /**
   * Records whose final write threw (decision 29): one that is final committed after all, so its
   * hooks run here; one that isn't stays listed, and the writer that finishes it runs them.
   */
  const runLostHooks = async () => {
    for (const key of [...records.unconfirmed]) {
      try {
        const record = await store.get(key);
        if (!record) records.unconfirmed.delete(key);
        else if (isFinalRecord(record)) {
          records.unconfirmed.delete(key);
          records.onFinal(record, "resolved");
          if (record.state === "success") records.onSuccess(record, "resolved");
        }
      } catch (error) {
        keyFailed(key, error);
      }
    }
  };

  /** The ledger bound of a hash stored without one (before 0005): the auth entry's expiry. */
  const fallbackLedger = (record: SettlementRecord): number | undefined => {
    try {
      const { transaction } = record.paymentPayload.payload as { transaction: string };
      return authExpiration(new Transaction(transaction, getNetworkPassphrase(network)));
    } catch {
      return undefined;
    }
  };

  /**
   * Whether the RPC's history reaches back to the record's claim: only then does `NOT_FOUND` say a
   * hash never landed. RPC keeps a window of ledgers (testnet's reports 120960, about 7 days;
   * other providers differ), so after a longer outage a landed hash is `NOT_FOUND` too.
   */
  const historyCovers = (record: SettlementRecord, res: rpc.Api.GetMissingTransactionResponse) =>
    res.oldestLedgerCloseTime <= record.createdAt / 1000;

  /**
   * Keys reported by `settlement_history_gone`, each logged once per process, with when it was
   * last checked: an operator resolves it, so it is checked again only every few minutes.
   */
  const historyGone = new Map<SettlementRecord["key"], number>();

  const pastBound = (
    record: SettlementRecord,
    attempt: SettlementAttempt,
    res: rpc.Api.GetMissingTransactionResponse,
  ) => {
    const maxLedger = attempt.maxLedger ?? fallbackLedger(record);
    return (
      (attempt.maxTime !== undefined && res.latestLedgerCloseTime > attempt.maxTime) ||
      (maxLedger !== undefined && res.latestLedger >= maxLedger)
    );
  };

  const resolveRecord = async (record: SettlementRecord): Promise<Outcome> => {
    if (record.hashes.length === 0) {
      if (record.state !== "claimed") return "open";
      // A call may still sign it, also another process's during a deploy (decisions 13, 27).
      if (now() <= record.createdAt + deps.budgetMs + MARGIN_MS) return "open";
      // Explicitly from `claimed`: atomic with `addHash`, so a hash stored meanwhile wins.
      // Against the version this sweep read: a claim reopened since is a new one (0073).
      const ended = await records.finalWrite(record.key, () =>
        store.transition(
          record.key,
          "claimed",
          { state: "rejected", errorReason: SETTLE_REASONS.interrupted, updatedAt: now() },
          record.version,
        ),
      );
      if (!ended) return "open";
      records.onFinal(ended, "resolved");
      return "rejected";
    }

    const attempts = await store.attempts(record.key);
    const dead: AttemptUpdate[] = [];
    let open = 0;
    for (const attempt of attempts) {
      if (attempt.state === "dead") continue;
      const res = await deps.rpc.getTransaction(attempt.hash);
      if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (!pastBound(record, attempt, res)) open++;
        else if (historyCovers(record, res)) dead.push({ hash: attempt.hash, state: "dead" });
        else {
          // It may have landed before the RPC's history: an operator checks it (decision 22).
          open++;
          if (!historyGone.has(record.key)) {
            logger.warn("settlement_history_gone", {
              network,
              settlementKey: record.key,
              transaction: attempt.hash,
              oldestLedger: res.oldestLedger,
            });
            metrics.increment("settlement_history_gone_total");
          }
          historyGone.set(record.key, now());
        }
        continue;
      }
      return land(record, attempt, res, dead);
    }
    // Every hash this read saw is dead. A `/settle` call may still store a rebuilt one, so the
    // write needs the version the record was listed with, which `attempts()` read after: a hash
    // stored since makes it fail, and the next sweep checks that hash too (decision 26).
    if (open === 0) {
      const { won } = await records.finish(
        record.key,
        { state: "expired", errorReason: SETTLE_REASONS.expired, attempts: dead },
        "resolved",
        record.version,
      );
      return won ? "expired" : "open";
    }
    if (dead.length > 0) await store.markAttempts(record.key, dead, now());
    return "open";
  };

  /**
   * One pass over the network's non-final records, at most `CONCURRENCY` at a time. A store that
   * fails to list rejects the sweep; a record whose RPC or store call fails is counted in
   * `errors` and stays as it is, for the next sweep. `onListed` runs once the records are listed.
   */
  const sweep = async (onListed?: () => void): Promise<SweepReport> => {
    const report: SweepReport = {
      rejected: 0,
      success: 0,
      failed: 0,
      expired: 0,
      open: 0,
      errors: 0,
    };
    await runLostHooks();
    await retryMarks();
    const queue = await store.listNonFinal(network);
    onListed?.();
    const worker = async () => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        const checkedAt = historyGone.get(record.key);
        if (checkedAt !== undefined && now() - checkedAt < HISTORY_GONE_RECHECK_MS) {
          report.open++;
          continue;
        }
        let outcome: Outcome;
        try {
          outcome = await resolveRecord(record);
        } catch (error) {
          logger.warn("settlement_reconcile_failed", {
            network,
            settlementKey: record.key,
            error,
          });
          outcome = "errors";
        }
        report[outcome]++;
        if (outcome !== "open" && outcome !== "errors") {
          historyGone.delete(record.key);
          metrics.increment("settlement_reconciled_total", { state: outcome });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    // Only a sweep that changed or failed something: one runs every few seconds.
    if (report.open < Object.values(report).reduce((sum, n) => sum + n, 0))
      logger.info("reconcile_finished", { network, ...report });
    return report;
  };

  /**
   * The pool's `resolved` event: a submission answered `pending` ended. The same writes as a
   * sweep, from the pool's result instead of an RPC call.
   */
  const resolved = async (result: SubmitResult): Promise<void> => {
    if (!result.hash || result.status === "pending") return;
    const record = await store.findByHash(result.hash);
    if (!record) return;
    const attempts = attemptUpdates(result.attempts, result);
    const fields = {
      ...(result.ledger !== undefined && { ledger: result.ledger }),
      ...(result.feeCharged !== undefined && { feeCharged: result.feeCharged }),
      channel: result.channel,
      attempts,
    };
    const { record: finished, won } = await records.finish(
      record.key,
      result.status === "success"
        ? { state: "success", ...fields }
        : { state: result.status, errorReason: SETTLE_REASONS[result.status], ...fields },
      "resolved",
    );
    if (result.status === "success" && won && finished) await markIfAnswered(finished);
  };

  return { sweep, resolved };
}

export type Reconciler = ReturnType<typeof createReconciler>;

/** Reconciliation in a serving process. */
export interface Reconciliation {
  /** Settles once the first sweep has ended, whether or not it failed: for tests. */
  readonly reconciled: Promise<void>;
  /**
   * True once a sweep has listed the network's non-final records, and from then on. The deploy
   * waits for it beside `ready`: an image whose sweeps can't list never turns it true (decision
   * 36).
   */
  listed(): boolean;
  /** Starts the sweeps; the server already listens, and `/settle` serves beside them. */
  start(): void;
  /** Stops the sweeps, and settles once a sweep under way has ended: the drain waits for it. */
  close(): Promise<void>;
}

/** Between the end of one sweep and the start of the next (decision 27). */
export const SWEEP_INTERVAL_MS = 10_000;

/**
 * Sweeps at start and then `SWEEP_INTERVAL_MS` after each sweep ends, so they never overlap
 * (decision 27): a record a crash, a restart or a store outage left open is finished within one
 * interval of the network deciding it, and a sweep that fails is simply followed by the next.
 * The timer doesn't keep the process alive.
 */
export function scheduleReconciliation(opts: {
  reconciler: Reconciler;
  logger: Logger;
  network: StellarNetwork;
}): Reconciliation {
  const { reconciler, logger, network } = opts;
  let closed = false;
  let listed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  let reconciled!: () => void;
  const done = new Promise<void>((resolve) => (reconciled = resolve));

  const tick = () => (sweeping = sweepOnce().finally(() => (sweeping = undefined)));
  const sweepOnce = async () => {
    try {
      await reconciler.sweep(() => (listed = true));
    } catch (error) {
      logger.warn("reconcile_failed", { network, error });
    }
    reconciled();
    if (closed) return;
    timer = setTimeout(() => void tick(), SWEEP_INTERVAL_MS);
    timer.unref();
  };

  return {
    reconciled: done,
    listed: () => listed,
    start: () => void tick(),
    async close() {
      closed = true;
      clearTimeout(timer);
      await sweeping;
    },
  };
}
