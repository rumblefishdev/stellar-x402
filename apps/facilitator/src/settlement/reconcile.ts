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
import { attemptUpdates, type Records } from "./records.js";
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
  /** `SETTLE_BUDGET_MS`: past it plus `marginMs`, no call adds a hash to a claim. */
  budgetMs: number;
  /** Added to the budget before a live sweep closes a claim with no hash (decision 13). */
  marginMs?: number;
  /** Records resolved at once, so a backlog after an outage doesn't flood the RPC. */
  concurrency?: number;
  now?: () => number;
}

/**
 * `startup`: no `/settle` call is running, so every claim without a hash is closed (decision 2).
 * `live`: calls may be, so only a claim past its budget is (decision 13).
 */
export type SweepMode = "startup" | "live";

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
 * (decision 1), and a record expires only once every hash is dead (decision 5).
 */
export function createReconciler(deps: ReconcilerDeps) {
  const { network, store, records, logger, metrics, now = Date.now } = deps;
  const marginMs = deps.marginMs ?? 5_000;
  const concurrency = deps.concurrency ?? 4;

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

  const markIfAnswered = async (record: SettlementRecord) => {
    await markAnswered(record.key);
    records.onSuccess(record, "resolved");
  };

  /** Successes already stored whose mark failed: their record is final, so no sweep reads it. */
  const retryMarks = async () => {
    for (const key of [...records.unmarked]) {
      const record = await store.get(key);
      if (record?.state === "success") await markAnswered(key);
    }
  };

  /** The ledger bound of a hash stored without one (before 0003): the auth entry's expiry. */
  const fallbackLedger = (record: SettlementRecord): number | undefined => {
    try {
      const { transaction } = record.paymentPayload.payload as { transaction: string };
      return authExpiration(new Transaction(transaction, getNetworkPassphrase(network)));
    } catch {
      return undefined;
    }
  };

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

  const resolveRecord = async (record: SettlementRecord, mode: SweepMode): Promise<Outcome> => {
    if (record.hashes.length === 0) {
      if (record.state !== "claimed") return "open";
      if (mode === "live" && now() <= record.createdAt + deps.budgetMs + marginMs) return "open";
      // Explicitly from `claimed`: atomic with `addHash`, so a hash stored meanwhile wins.
      const ended = await store.transition(record.key, "claimed", {
        state: "rejected",
        errorReason: SETTLE_REASONS.interrupted,
        updatedAt: now(),
      });
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
        if (pastBound(record, attempt, res)) dead.push({ hash: attempt.hash, state: "dead" });
        else open++;
        continue;
      }
      return land(record, attempt, res, dead);
    }
    // Every hash is dead: none can land any more.
    if (open === 0) {
      const { won } = await records.finish(
        record.key,
        { state: "expired", errorReason: SETTLE_REASONS.expired, attempts: dead },
        "resolved",
      );
      return won ? "expired" : "open";
    }
    if (dead.length > 0) await store.markAttempts(record.key, dead, now());
    return "open";
  };

  let running: Promise<SweepReport> | undefined;

  /**
   * One pass over the network's non-final records, at most `concurrency` at a time. A store that
   * fails to list rejects the sweep; a record whose RPC or store call fails is counted in
   * `errors` and stays as it is. One sweep runs at a time: a call during one gets its report.
   */
  const sweep = (mode: SweepMode): Promise<SweepReport> => {
    running ??= (async () => {
      const report: SweepReport = {
        rejected: 0,
        success: 0,
        failed: 0,
        expired: 0,
        open: 0,
        errors: 0,
      };
      await retryMarks();
      const queue = await store.listNonFinal(network);
      const worker = async () => {
        for (let record = queue.shift(); record; record = queue.shift()) {
          let outcome: Outcome;
          try {
            outcome = await resolveRecord(record, mode);
          } catch (error) {
            logger.warn("settlement_reconcile_failed", {
              network,
              settlementKey: record.key,
              error,
            });
            outcome = "errors";
          }
          report[outcome]++;
          if (outcome !== "open" && outcome !== "errors")
            metrics.increment("settlement_reconciled_total", { state: outcome });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      logger.info("reconcile_finished", { network, mode, ...report });
      return report;
    })().finally(() => (running = undefined));
    return running;
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
