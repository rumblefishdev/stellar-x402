import type { StellarNetwork } from "@stellar-x402/config";
import type { Attempt, SubmitResult } from "@stellar-x402/signer-pool";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import {
  FINAL_SETTLEMENT_STATES,
  type AttemptUpdate,
  type SettlementKey,
  type SettlementRecord,
  type SettlementStore,
  type SettlementUpdate,
} from "../ports/index.js";
import type { SettlementHooks, SettlementOrigin } from "./hooks.js";

export interface RecordsDeps {
  network: StellarNetwork;
  store: SettlementStore;
  hooks: Pick<SettlementHooks, "onFinal" | "onSuccess">;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

export const isFinalRecord = (record: SettlementRecord) =>
  FINAL_SETTLEMENT_STATES.includes(record.state);

/**
 * The settlement module's record writes (AD-16): every change to a record goes through
 * {@link Records.advance} or {@link Records.finish}, forward-only compare-and-sets, and the hooks
 * run here, once for the writer that made a record final. `/settle` and reconciliation share one,
 * so `answeredHere` is one process-wide set.
 */
export function createRecords(deps: RecordsDeps) {
  const { network, store, logger, metrics, now = Date.now } = deps;

  const hookFailed = (hook: keyof SettlementHooks, key: SettlementKey, error: unknown) => {
    logger.error("settlement_hook_failed", { hook, network, settlementKey: key, error });
    metrics.increment("settlement_hook_failures_total", { hook });
  };

  const recordFailed = (key: SettlementKey, error: unknown) => {
    logger.error("settlement_record_failed", { network, settlementKey: key, error });
    metrics.increment("settlement_record_failures_total");
  };

  /** Runs a hook without letting it reach the caller (hooks.ts). */
  const runHook = (hook: "onFinal" | "onSuccess", key: SettlementKey, run: () => Promise<void>) => {
    const failed = (error: unknown) => hookFailed(hook, key, error);
    try {
      run().catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  const onFinal = (record: SettlementRecord, origin: SettlementOrigin) =>
    runHook("onFinal", record.key, () => deps.hooks.onFinal(record, origin));

  const onSuccess = (record: SettlementRecord, origin: SettlementOrigin) =>
    runHook("onSuccess", record.key, () => deps.hooks.onSuccess(record, origin));

  /**
   * Moves a record forward from whatever state it is in now. `undefined` means another writer got
   * there first, or the record is already final. `update.attempts` are written either way: they
   * say what the network did, whoever finishes the record.
   */
  const advance = async (key: SettlementKey, update: Omit<SettlementUpdate, "updatedAt">) => {
    for (let tries = 0; tries < 3; tries++) {
      const current = await store.get(key);
      if (!current || isFinalRecord(current)) {
        if (current && update.attempts?.length)
          await store.markAttempts(key, update.attempts, now());
        return undefined;
      }
      const moved = await store.transition(key, current.state, { ...update, updatedAt: now() });
      if (moved) return moved;
    }
    return undefined;
  };

  /** {@link advance}, then `onFinal` once for the writer that made the record final. */
  const finish = async (
    key: SettlementKey,
    update: Omit<SettlementUpdate, "updatedAt">,
    origin: SettlementOrigin,
  ) => {
    const record = await advance(key, update);
    if (record && isFinalRecord(record)) onFinal(record, origin);
    return { record: record ?? (await store.get(key)), won: record !== undefined, origin };
  };

  /**
   * Keys whose success this process is answering, or answered without the store's mark: a mark
   * in flight, a mark that failed, or a success answered from the pool's result when the store
   * failed. Checked before the store, so one process answers a success once even while the store
   * is down (0009 decision 29). Keys leave once the store holds the mark (or refused it).
   */
  const answeredHere = new Set<SettlementKey>();

  return {
    hookFailed,
    recordFailed,
    onFinal,
    onSuccess,
    advance,
    finish,
    answeredHere,
  };
}

export type Records = ReturnType<typeof createRecords>;

/**
 * What a submission's attempts say about each hash (0019 decision 7), from its result, or from
 * the error `submit()` rejected with. Every attempt before the last was refused with `txBadSeq`:
 * only that makes the pool rebuild. The last one is `landed` once in a ledger, `dead` once
 * refused or past its bounds, and otherwise `sent` or `unknown` as the pool saw the send; one the
 * pool never sent is `dead`, since nothing else holds the envelope.
 */
export function attemptUpdates(
  attempts: readonly Attempt[],
  outcome: Pick<SubmitResult, "status" | "channel" | "errorCode"> | { error: unknown },
): AttemptUpdate[] {
  const channel = "status" in outcome ? outcome.channel : undefined;
  const at = (hash: string, update: Omit<AttemptUpdate, "hash">): AttemptUpdate => ({
    hash,
    ...update,
    ...(channel !== undefined && { channel }),
  });
  return attempts.map((attempt, i) => {
    if (i < attempts.length - 1) return at(attempt.hash, { state: "dead", errorCode: "txBadSeq" });
    if ("status" in outcome) {
      switch (outcome.status) {
        case "success":
        case "failed":
          return at(attempt.hash, { state: "landed" });
        case "rejected":
        case "expired":
          return at(attempt.hash, {
            state: "dead",
            ...(outcome.errorCode !== undefined && { errorCode: outcome.errorCode }),
          });
        case "pending":
          break;
      }
    }
    if (attempt.sent === "no") return at(attempt.hash, { state: "dead" });
    return at(attempt.hash, { state: attempt.sent === "yes" ? "sent" : "unknown" });
  });
}
