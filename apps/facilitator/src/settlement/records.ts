import type { StellarNetwork } from "@stellar-x402/config";
import type { Attempt, SubmitResult } from "@stellar-x402/signer-pool";
import type { Logger } from "../logger.js";
import type { NetworkMetrics } from "../metrics.js";
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
  metrics: NetworkMetrics;
  now?: () => number;
}

/**
 * What a write must still find: the `version` its writer read (no hash appended since), and the
 * `reopened` count of its writer's `claim` (not reopened since, 0073 decision 24).
 */
export interface WriteGuard {
  version?: number;
  claim?: number;
}

export const isFinalRecord = (record: SettlementRecord) =>
  FINAL_SETTLEMENT_STATES.includes(record.state);

/**
 * The settlement module's record writes (AD-16): every state change after the claim goes through
 * {@link Records.advance} or {@link Records.finish}, forward-only compare-and-sets, and the hooks
 * run here, once for the writer that made a record final. The rest of `settlement/` writes only
 * what moves no state: a hash (`addHash`), an attempt hint (`markAttempts`), the answered mark,
 * and reconciliation's close of a hashless claim, a compare-and-set from `claimed` that must not
 * retry from a later state. `/settle` and reconciliation share one,
 * so `answeredHere` is one process-wide set.
 */
export function createRecords(deps: RecordsDeps) {
  const { network, store, logger, metrics, now = Date.now } = deps;

  const hookFailed = (hook: keyof SettlementHooks, key: SettlementKey, error: unknown) => {
    logger.error("settlement_hook_failed", { hook, network, settlementKey: key, error });
    metrics.increment("settlement_hook_failures_total", { hook });
  };

  /** A store write failed: the record stays as it was, for the next sweep (0019 decision 27). */
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

  /**
   * `fee_charged_stroops` (0027): a transaction that landed was charged its fee. Counted where
   * `onFinal` runs, once for the write that made the record final (or for the sweep that found a
   * write that threw final, decision 29), so a record two writers race to finish counts once, as
   * the spend policy's `commit` does. A record with no fee (rejected, expired) adds nothing.
   */
  const charged = (state: SettlementRecord["state"], feeCharged: bigint | undefined) => {
    if (feeCharged !== undefined)
      metrics.increment("fee_charged_stroops", { state }, Number(feeCharged));
  };

  const onFinal = (record: SettlementRecord, origin: SettlementOrigin) => {
    charged(record.state, record.feeCharged);
    runHook("onFinal", record.key, () => deps.hooks.onFinal(record, origin));
  };

  const onSuccess = (record: SettlementRecord, origin: SettlementOrigin) =>
    runHook("onSuccess", record.key, () => deps.hooks.onSuccess(record, origin));

  /**
   * Moves a record forward from whatever state it is in now. `undefined` means another writer got
   * there first, the record is already final, or the guard failed: with `version`, a hash was
   * appended since the caller read it; with `claim`, the record was reopened since the caller's
   * claim (0073 decision 24). `update.attempts` are written either way: they say what the network
   * did, whoever finishes the record. With `final`, each write goes through {@link finalWrite}; the
   * reads don't, since a failed read wrote nothing (0019 decision 34).
   */
  const advance = async (
    key: SettlementKey,
    update: Omit<SettlementUpdate, "updatedAt">,
    guard: WriteGuard = {},
    final = false,
  ) => {
    const { version, claim } = guard;
    for (let tries = 0; tries < 3; tries++) {
      const current = await store.get(key);
      const stale =
        (version !== undefined && current?.version !== version) ||
        (claim !== undefined && current?.reopened !== claim);
      if (!current || isFinalRecord(current) || stale) {
        // `expired` is final, so this write is lost: only the log tells an operator (0088).
        if (
          current?.state === "expired" &&
          (update.state === "success" || update.state === "failed")
        ) {
          logger.error("settlement_landed_after_expired", {
            network,
            settlementKey: key,
            state: update.state,
            transaction: update.attempts?.find((attempt) => attempt.state === "landed")?.hash,
            ledger: update.ledger,
          });
          metrics.increment("settlement_landed_after_expired_total", { state: update.state });
          // The write is lost, but the network charged the fee: no `onFinal` counts it.
          charged(update.state, update.feeCharged);
        }
        if (current && update.attempts?.length)
          await store.markAttempts(key, update.attempts, now());
        return undefined;
      }
      const from = current.state;
      const write = () =>
        store.transition(key, from, { ...update, updatedAt: now() }, version, claim);
      const moved = final ? await finalWrite(key, write) : await write();
      if (moved) return moved;
    }
    return undefined;
  };

  /**
   * Keys whose write to a final state threw: it may still have committed, and then nothing comes
   * back to the record, so its hooks would never run. Reconciliation reads each, runs the hooks of
   * one it finds final, and leaves one it doesn't to the usual path (0019 decision 29). A writer in
   * this process takes the key out while its write runs, so the sweep doesn't run the hooks beside
   * it, and keeps it out once the record is final (decision 35), also when another writer put it
   * back meanwhile; a restart forgets it.
   */
  const unconfirmed = new Set<SettlementKey>();
  /** How many final writes per key are running now, in this process. */
  const inFlight = new Map<SettlementKey, number>();
  /**
   * Keys a final write in this process won while others were still running (0027 decision 55).
   * A win moves the record from a non-final state, so a racing write that throws or loses after it
   * can't be the one that committed, and must not put the key back: the sweep would run the hooks,
   * and count the fee, a second time. Forgotten once the last write for the key ends, so a
   * reopened record's later write (0073) is listed as before.
   */
  const won = new Set<SettlementKey>();

  /**
   * Runs `write`, one store write that may make the record final, keeping track of it for the
   * hooks. Only the write goes in here: a read that fails before it wrote nothing.
   */
  const finalWrite = async (
    key: SettlementKey,
    write: () => Promise<SettlementRecord | undefined>,
  ) => {
    const listed = unconfirmed.delete(key);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    try {
      let record: SettlementRecord | undefined;
      try {
        record = await write();
      } catch (error) {
        if (!won.has(key)) unconfirmed.add(key);
        throw error;
      }
      if (record) {
        // Won: this compare-and-set moved the record from a non-final state, so no write that
        // threw committed first, and none can commit after.
        won.add(key);
        unconfirmed.delete(key);
      } else if (listed && !won.has(key)) {
        // Lost, and not to a writer here: an earlier write of ours may be the one that committed.
        unconfirmed.add(key);
      }
      return record;
    } finally {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left > 0) inFlight.set(key, left);
      else {
        inFlight.delete(key);
        won.delete(key);
      }
    }
  };

  /** {@link advance}, then `onFinal` once for the writer that made the record final. */
  const finish = async (
    key: SettlementKey,
    update: Omit<SettlementUpdate, "updatedAt">,
    origin: SettlementOrigin,
    guard: WriteGuard = {},
  ) => {
    const record = await advance(key, update, guard, true);
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
  /**
   * Keys of `answeredHere` whose success went out without the store's mark: the mark failed, or
   * the store failed to record the pool's success. Reconciliation marks them once the store is
   * back (0019 decision 9); a restart forgets them, and they stay unmarked.
   */
  const unmarked = new Set<SettlementKey>();

  return {
    hookFailed,
    recordFailed,
    onFinal,
    onSuccess,
    advance,
    finalWrite,
    finish,
    answeredHere,
    unmarked,
    unconfirmed,
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
