import type { StellarNetwork } from "@stellar-x402/config";
import type { Logger } from "../logger.js";
import type { SettlementAttempt, SettlementRecord, SettlementStore } from "../ports/index.js";
import { payerLedgerBound, SWEEP_INTERVAL_MS } from "./reconcile.js";
import { isFinalRecord } from "./records.js";

/** An attempt that may still land: the network has given no answer for it yet. */
const OPEN_STATES = new Set<SettlementAttempt["state"]>(["stored", "sent", "unknown"]);

interface OpenAttempt {
  key: SettlementRecord["key"];
  hash: string;
}

export interface ChannelHolderDeps {
  store: Pick<SettlementStore, "listNonFinal" | "attempts" | "get">;
  network: StellarNetwork;
  /** This process's channels; an attempt on another one is not ours to hold. */
  channels: readonly string[];
  /** The network's latest ledger, to tell which bounds have passed. */
  latestLedger: () => Promise<number>;
  /** Keeps a channel from every call until `until` settles: the submitter's `hold`. */
  hold: (address: string, until: Promise<unknown>) => void;
  logger: Logger;
  /** How often a held channel's attempts are read again; the sweep's interval by default. */
  intervalMs?: number;
  now?: () => number;
}

export interface ChannelHolder {
  /**
   * Holds back every channel with an attempt that may still land (0090): one in `stored`, `sent`
   * or `unknown` whose bound hasn't passed. Each hold ends once reconciliation has marked all of
   * the channel's attempts `landed` or `dead`, or their records final. Runs when the lease is
   * acquired, before `/settle` may send; rejects if the store can't be read, or the RPC when an
   * attempt is open, so the lease isn't taken up without it.
   */
  holdOpen(): Promise<void>;
  /** Stops reading the store; holds still running never end. For the shutdown. */
  close(): void;
}

/**
 * Keeps a new process off a channel the previous one left a transaction open on (0090). A deploy
 * drains for at most 150 s, while a sent transaction stays valid until its payer's authorization
 * expires; a send on that channel meanwhile would only get `txBadSeq` and rebuild until the old one
 * is final (ADR 0011). The store is the only thing the previous process leaves behind, so its
 * attempts, with their channel and bound, tell which channels to hold.
 */
export function createChannelHolder(deps: ChannelHolderDeps): ChannelHolder {
  const { store, network, logger, intervalMs = SWEEP_INTERVAL_MS, now = Date.now } = deps;
  const ours = new Set(deps.channels);
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timer.unref();
      timers.add(timer);
    });

  /** Whether the attempt can still land at `ledger`, or its bound is unknown. */
  const mayLand = (record: SettlementRecord, attempt: SettlementAttempt, ledger: number) => {
    if (!OPEN_STATES.has(attempt.state)) return false;
    if (attempt.maxLedger !== undefined) return ledger <= attempt.maxLedger;
    if (attempt.maxTime !== undefined) return now() / 1000 <= attempt.maxTime;
    const bound = payerLedgerBound(record, network);
    // No bound to read: reconciliation keeps it open too, so hold until it decides.
    return bound === undefined || ledger <= bound;
  };

  /** Whether reconciliation has answered for the attempt, or for its whole record. */
  const ended = async ({ key, hash }: OpenAttempt) => {
    const record = await store.get(key);
    if (!record || isFinalRecord(record)) return true;
    const attempt = (await store.attempts(key)).find((a) => a.hash === hash);
    return attempt === undefined || attempt.state === "landed" || attempt.state === "dead";
  };

  /** Resolves once every attempt has ended; never while the store can't be read. */
  const untilEnded = async (channel: string, open: OpenAttempt[]) => {
    let left = open;
    while (left.length > 0) {
      await sleep(intervalMs);
      if (closed) return new Promise<never>(() => {});
      const still: OpenAttempt[] = [];
      for (const attempt of left) {
        try {
          if (!(await ended(attempt))) still.push(attempt);
        } catch (error) {
          still.push(attempt);
          logger.warn("channel_hold_check_failed", { network, channel, error });
        }
      }
      left = still;
    }
    logger.info("channel_freed", { network, channel });
  };

  return {
    async holdOpen() {
      const candidates: { record: SettlementRecord; attempt: SettlementAttempt }[] = [];
      for (const record of await store.listNonFinal(network))
        for (const attempt of await store.attempts(record.key))
          if (attempt.channel !== undefined && ours.has(attempt.channel))
            if (OPEN_STATES.has(attempt.state)) candidates.push({ record, attempt });
      // The ledger only when there is a bound to compare, so a start with nothing open needs no RPC.
      if (candidates.length === 0) return;
      const ledger = await deps.latestLedger();
      const byChannel = new Map<string, OpenAttempt[]>();
      for (const { record, attempt } of candidates) {
        if (!mayLand(record, attempt, ledger)) continue;
        const open = byChannel.get(attempt.channel!) ?? [];
        open.push({ key: record.key, hash: attempt.hash });
        byChannel.set(attempt.channel!, open);
      }
      for (const [channel, open] of byChannel) {
        logger.info("channel_held", {
          network,
          channel,
          transactions: open.map((a) => a.hash),
          ledger,
        });
        deps.hold(channel, untilEnded(channel, open));
      }
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
