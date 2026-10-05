import type { SubmitResult, SubmitStatus } from "./types.js";

/** Why a submission ended before anything was sent. */
export type RefusalReason = "simulation" | "check" | "fee-limit" | "other";

export type SubmitterEvent =
  /** The network accepted the transaction (`PENDING` or `DUPLICATE`). */
  | { type: "sent"; channel: string; hash: string; attempts: number }
  /** A send is retried on the next ledger. */
  | {
      type: "send-retry";
      channel: string;
      hash: string;
      reason: "try-again-later" | "send-error";
    }
  /** A submission ended with a result; `queuedMs` is the wait for a free channel. */
  | { type: "final"; result: SubmitResult; queuedMs: number; totalMs: number }
  /** A submission ended with an error before anything was sent. */
  | { type: "refused"; channel: string; reason: RefusalReason; message: string };

export interface SubmitterStatsSnapshot {
  channels: number;
  busy: number;
  queued: number;
  byStatus: Record<SubmitStatus, number>;
  refused: Record<RefusalReason, number>;
  /** Result codes of `failed` and `rejected` submissions. */
  errorCodes: Record<string, number>;
  sendRetries: number;
  feesChargedStroops: bigint;
  /** Successful and failed landings per ledger, for the most recent ledgers. */
  landingsByLedger: Record<number, number>;
}

const LEDGERS_KEPT = 20;

/** Folds {@link SubmitterEvent}s into counters. */
export class SubmitterStats {
  private byStatus: Record<SubmitStatus, number> = {
    success: 0,
    failed: 0,
    rejected: 0,
    expired: 0,
  };
  private refused: Record<RefusalReason, number> = {
    simulation: 0,
    check: 0,
    "fee-limit": 0,
    other: 0,
  };
  private errorCodes: Record<string, number> = {};
  private sendRetries = 0;
  private fees = 0n;
  private landings = new Map<number, number>();

  record(event: SubmitterEvent): void {
    switch (event.type) {
      case "send-retry":
        this.sendRetries++;
        break;
      case "refused":
        this.refused[event.reason]++;
        break;
      case "final": {
        const r = event.result;
        this.byStatus[r.status]++;
        if (r.errorCode) this.errorCodes[r.errorCode] = (this.errorCodes[r.errorCode] ?? 0) + 1;
        if (r.feeCharged) this.fees += r.feeCharged;
        if (r.ledger !== undefined) {
          this.landings.set(r.ledger, (this.landings.get(r.ledger) ?? 0) + 1);
          if (this.landings.size > LEDGERS_KEPT) {
            const oldest = Math.min(...this.landings.keys());
            this.landings.delete(oldest);
          }
        }
        break;
      }
      case "sent":
        break;
    }
  }

  snapshot(pool: { channels: number; busy: number; queued: number }): SubmitterStatsSnapshot {
    return {
      ...pool,
      byStatus: { ...this.byStatus },
      refused: { ...this.refused },
      errorCodes: { ...this.errorCodes },
      sendRetries: this.sendRetries,
      feesChargedStroops: this.fees,
      landingsByLedger: Object.fromEntries(this.landings),
    };
  }
}
