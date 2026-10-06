import type { SubmitResult, SubmitStatus } from "./types.js";

/** Why a submission ended before anything was sent. */
export type RefusalReason =
  "simulation" | "check" | "fee-limit" | "queue-timeout" | "no-channels" | "other";

export type SubmitterEvent =
  /** The network accepted the transaction (`PENDING` or `DUPLICATE`). */
  | { type: "sent"; channel: string; hash: string; attempts: number }
  /** A plain `txBadSeq`: the sequence is re-read and the envelope rebuilt once. */
  | { type: "sequence-resync"; channel: string }
  /** A channel that could not be read for `timeoutSeconds` was taken out of the pool. */
  | { type: "channel-quarantined"; channel: string; reason: string }
  /** The final outcome of a submission that was reported `pending`. */
  | { type: "resolved"; result: SubmitResult }
  /** Reading a channel's sequence number failed; it is retried on the next ledger. */
  | { type: "read-retry"; channel: string; message: string }
  /** A send is retried on the next ledger. */
  | {
      type: "send-retry";
      channel: string;
      hash: string;
      reason: "try-again-later" | "send-error";
    }
  /**
   * An envelope prepared while the channel's previous transaction was pending was sent (`used`)
   * or rebuilt because that transaction did not use its sequence number or time ran short.
   */
  | { type: "prepared-ahead"; channel: string; used: boolean }
  /** The inclusion fee bid was raised above `base` because `queued` calls were waiting. */
  | { type: "fee-raised"; channel: string; base: number; bid: number; queued: number }
  /** A submission ended with a result; `queuedMs` is the wait for a free channel. */
  | { type: "final"; result: SubmitResult; queuedMs: number; totalMs: number }
  /**
   * A submission ended with an error before anything was sent. `channel` is missing when no
   * channel was acquired.
   */
  | { type: "refused"; channel?: string; reason: RefusalReason; message: string };

export interface SubmitterStatsSnapshot {
  channels: number;
  busy: number;
  queued: number;
  byStatus: Record<SubmitStatus, number>;
  refused: Record<RefusalReason, number>;
  /** Result codes of `failed` and `rejected` submissions. */
  errorCodes: Record<string, number>;
  sendRetries: number;
  /** Failed reads of a channel's sequence number that were retried. */
  readRetries: number;
  /** Plain `txBadSeq` rejections that were rebuilt with a re-read sequence. */
  sequenceResyncs: number;
  /** Channels taken out of the pool. */
  quarantined: number;
  /** Final outcomes of submissions first reported `pending`. */
  resolved: Record<SubmitStatus, number>;
  /** Pipelined envelopes sent as prepared, and those rebuilt. */
  preparedAhead: { used: number; rebuilt: number };
  /** Envelopes built with a raised inclusion fee bid, and the highest bid so far. */
  feeRaises: { count: number; highestBid: number };
  feesChargedStroops: bigint;
  /** Successful and failed landings per ledger, for the most recent ledgers. */
  landingsByLedger: Record<number, number>;
}

const LEDGERS_KEPT = 20;

/** Folds {@link SubmitterEvent}s into counters. */
export class SubmitterStats {
  private byStatus = emptyByStatus();
  private resolved = emptyByStatus();
  private refused: Record<RefusalReason, number> = {
    simulation: 0,
    check: 0,
    "fee-limit": 0,
    "queue-timeout": 0,
    "no-channels": 0,
    other: 0,
  };
  private sequenceResyncs = 0;
  private quarantined = 0;
  private errorCodes: Record<string, number> = {};
  private sendRetries = 0;
  private readRetries = 0;
  private preparedAhead = { used: 0, rebuilt: 0 };
  private feeRaises = { count: 0, highestBid: 0 };
  private fees = 0n;
  private landings = new Map<number, number>();

  record(event: SubmitterEvent): void {
    switch (event.type) {
      case "send-retry":
        this.sendRetries++;
        break;
      case "read-retry":
        this.readRetries++;
        break;
      case "sequence-resync":
        this.sequenceResyncs++;
        break;
      case "channel-quarantined":
        this.quarantined++;
        break;
      case "resolved":
        this.resolved[event.result.status]++;
        this.recordLanding(event.result);
        break;
      case "prepared-ahead":
        if (event.used) this.preparedAhead.used++;
        else this.preparedAhead.rebuilt++;
        break;
      case "fee-raised":
        this.feeRaises.count++;
        this.feeRaises.highestBid = Math.max(this.feeRaises.highestBid, event.bid);
        break;
      case "refused":
        this.refused[event.reason]++;
        break;
      case "final": {
        const r = event.result;
        this.byStatus[r.status]++;
        this.recordLanding(r);
        break;
      }
      case "sent":
        break;
    }
  }

  private recordLanding(r: SubmitResult): void {
    if (r.errorCode) this.errorCodes[r.errorCode] = (this.errorCodes[r.errorCode] ?? 0) + 1;
    if (r.feeCharged) this.fees += r.feeCharged;
    if (r.ledger !== undefined) {
      this.landings.set(r.ledger, (this.landings.get(r.ledger) ?? 0) + 1);
      if (this.landings.size > LEDGERS_KEPT) {
        const oldest = Math.min(...this.landings.keys());
        this.landings.delete(oldest);
      }
    }
  }

  snapshot(pool: { channels: number; busy: number; queued: number }): SubmitterStatsSnapshot {
    return {
      ...pool,
      byStatus: { ...this.byStatus },
      refused: { ...this.refused },
      errorCodes: { ...this.errorCodes },
      sendRetries: this.sendRetries,
      readRetries: this.readRetries,
      sequenceResyncs: this.sequenceResyncs,
      quarantined: this.quarantined,
      resolved: { ...this.resolved },
      preparedAhead: { ...this.preparedAhead },
      feeRaises: { ...this.feeRaises },
      feesChargedStroops: this.fees,
      landingsByLedger: Object.fromEntries(this.landings),
    };
  }
}

function emptyByStatus(): Record<SubmitStatus, number> {
  return { success: 0, failed: 0, rejected: 0, expired: 0, pending: 0 };
}
