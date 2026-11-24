import type { StellarNetwork } from "@stellar-x402/config";
import { cannotLand } from "@stellar-x402/signer-pool";
import type { Logger } from "../logger.js";
import type { SettlementAttempt, SettlementRecord, SettlementStore } from "../ports/index.js";
import { payerLedgerBound, SWEEP_INTERVAL_MS } from "./reconcile.js";
import { isFinalRecord } from "./records.js";

/** An attempt that may still land: the network has given no answer for it yet. */
const OPEN_STATES = new Set<SettlementAttempt["state"]>(["stored", "sent", "unknown"]);

interface OpenAttempt {
  key: SettlementRecord["key"];
  hash: string;
  /** Its time bound, in Unix seconds, if it has one. */
  maxTime?: number;
  /** Its ledger bound, or the payer's auth expiry for a hash stored without one. */
  maxLedger?: number;
}

/** The network's latest ledger: its sequence and its close time in Unix seconds. */
export interface LatestLedger {
  sequence: number;
  closeTime: number;
}

export interface ChannelHolderDeps {
  store: Pick<SettlementStore, "listNonFinal" | "attempts" | "get">;
  network: StellarNetwork;
  /** This process's channels; an attempt on another one is not ours to hold. */
  channels: readonly string[];
  /** The network's latest ledger, to tell which bounds have passed. */
  latestLedger: () => Promise<LatestLedger>;
  /** Keeps a channel from every call until `until` settles: the submitter's `hold`. */
  hold: (address: string, until: Promise<unknown>) => void;
  logger: Logger;
  /** How often a held channel's attempts are read again; the sweep's interval by default. */
  intervalMs?: number;
}

export interface ChannelHolder {
  /**
   * Holds back every channel with an attempt that may still land (0090): one in `stored`, `sent`
   * or `unknown` whose bound hasn't passed. Each hold ends once every one of the channel's attempts
   * has ended: reconciliation marked it `landed` or `dead`, or its record final, or the network is
   * past its bound by the `NOT_FOUND` margin, so it can no longer land (review D1). Runs when the
   * lease is acquired, before `/settle` may send; rejects if the store can't be read, or the RPC
   * when an attempt is open, so the lease isn't taken up without it.
   *
   * It runs on every acquire and adds holds each time: after a lost lease is taken back, a channel
   * already held gets a second hold (holds stack), and this process's own open attempts are held
   * too, since another process may have sent on their channels meanwhile. A channel the pool no
   * longer has (retired) is skipped.
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
  const { store, network, logger, intervalMs = SWEEP_INTERVAL_MS } = deps;
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

  /** The attempt with the bounds it can land within; the payer's auth expiry for an old hash. */
  const openAttempt = (record: SettlementRecord, attempt: SettlementAttempt): OpenAttempt => {
    const maxLedger =
      attempt.maxLedger ??
      (attempt.maxTime === undefined ? payerLedgerBound(record, network) : undefined);
    return {
      key: record.key,
      hash: attempt.hash,
      ...(attempt.maxTime !== undefined && { maxTime: attempt.maxTime }),
      ...(maxLedger !== undefined && { maxLedger }),
    };
  };

  /** Whether the attempt can still land at `latest`. One with no bound to read can. */
  const mayLand = (open: OpenAttempt, latest: LatestLedger) => {
    if (open.maxLedger !== undefined) return latest.sequence <= open.maxLedger;
    if (open.maxTime !== undefined) return latest.closeTime <= open.maxTime;
    return true;
  };

  /** Past its bound by the margin reconciliation also waits for: it can no longer land. */
  const pastBound = (open: OpenAttempt, latest: LatestLedger) =>
    cannotLand(
      { latestLedger: latest.sequence, latestLedgerCloseTime: latest.closeTime },
      { maxTime: open.maxTime, maxLedger: open.maxLedger },
    );

  /** Whether reconciliation has answered for the attempt, or for its whole record. */
  const ended = async ({ key, hash }: OpenAttempt) => {
    const record = await store.get(key);
    if (!record || isFinalRecord(record)) return true;
    const attempt = (await store.attempts(key)).find((a) => a.hash === hash);
    return attempt === undefined || attempt.state === "landed" || attempt.state === "dead";
  };

  /**
   * Resolves once every attempt has ended: answered by reconciliation, or past its bound by the
   * margin. A read that fails leaves the attempt held until a later poll.
   */
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
      // Reconciliation may never answer (a hash past the RPC's history, a stopped sweep), so the
      // bound ends a hold too. The pool reads the channel's sequence again when the hold ends, so a
      // transaction that did land leaves no stale sequence behind.
      if (still.length > 0) {
        try {
          const latest = await deps.latestLedger();
          left = still.filter((attempt) => !pastBound(attempt, latest));
        } catch (error) {
          left = still;
          logger.warn("channel_hold_check_failed", { network, channel, error });
        }
      } else left = still;
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
      const latest = await deps.latestLedger();
      const byChannel = new Map<string, OpenAttempt[]>();
      for (const { record, attempt } of candidates) {
        const open = openAttempt(record, attempt);
        if (!mayLand(open, latest)) continue;
        const list = byChannel.get(attempt.channel!) ?? [];
        list.push(open);
        byChannel.set(attempt.channel!, list);
      }
      for (const [channel, open] of byChannel) {
        const transactions = open.map((a) => a.hash);
        // The polling starts only once the pool took the hold, so a refused one leaves no loop.
        let begin!: () => void;
        const until = new Promise<void>((resolve) => (begin = resolve)).then(() =>
          untilEnded(channel, open),
        );
        try {
          deps.hold(channel, until);
          begin();
        } catch (error) {
          // Retired: the pool never hands it out again, so there is nothing to hold.
          logger.warn("channel_hold_skipped", { network, channel, transactions, error });
          continue;
        }
        logger.info("channel_held", { network, channel, transactions, ledger: latest.sequence });
      }
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
