import type { SorobanRpc } from "./types.js";

/**
 * One shared `getLatestLedger` poll for all waiting submissions, so confirmation costs one
 * status check per pending transaction per new ledger instead of a fixed-interval poll each.
 * The loop runs only while someone is waiting.
 */
export class LedgerClock {
  private latest = 0;
  private waiters: { after: number; resolve: (seq: number) => void }[] = [];
  private running = false;

  constructor(
    private readonly rpc: Pick<SorobanRpc, "getLatestLedger">,
    private readonly intervalMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /** The newest ledger seen so far (0 before the first poll). */
  get current(): number {
    return this.latest;
  }

  /** Resolves with the first ledger sequence greater than `after`. */
  next(after: number): Promise<number> {
    if (this.latest > after) return Promise.resolve(this.latest);
    return new Promise((resolve) => {
      this.waiters.push({ after, resolve });
      if (!this.running) void this.loop();
    });
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.waiters.length > 0) {
        try {
          const { sequence } = await this.rpc.getLatestLedger();
          if (sequence > this.latest) this.latest = sequence;
        } catch {
          // A failed poll is retried on the next tick; waiters only care about progress.
        }
        const ready = this.waiters.filter((w) => this.latest > w.after);
        this.waiters = this.waiters.filter((w) => this.latest <= w.after);
        for (const w of ready) w.resolve(this.latest);
        if (this.waiters.length > 0) await this.sleep(this.intervalMs);
      }
    } finally {
      this.running = false;
    }
  }
}
