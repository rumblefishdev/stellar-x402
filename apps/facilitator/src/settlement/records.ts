import type { StellarNetwork } from "@stellar-x402/config";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import {
  FINAL_SETTLEMENT_STATES,
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
   * there first, or the record is already final.
   */
  const advance = async (key: SettlementKey, update: Omit<SettlementUpdate, "updatedAt">) => {
    for (let tries = 0; tries < 3; tries++) {
      const current = await store.get(key);
      if (!current || isFinalRecord(current)) return undefined;
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
