import type { SorobanRpc } from "./types.js";

/**
 * One shared `getLatestLedger` poll for all waiting submissions, so confirmation costs one
 * status check per pending transaction per new ledger instead of a fixed-interval poll each.
 * The loop runs only while someone is waiting. A waiter can carry a deadline on the `now` clock,
 * so a wait ends even when the RPC never answers.
 */
export class LedgerClock {
  private latest = 0;
  private waiters: { after: number; deadline?: number; resolve: (seq: number) => void }[] = [];
  private running = false;

  constructor(
    private readonly rpc: Pick<SorobanRpc, "getLatestLedger">,
    private readonly intervalMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The newest ledger seen so far (0 before the first poll). */
  get current(): number {
    return this.latest;
  }

  /**
   * Resolves with the first ledger sequence greater than `after`, or with the newest one seen
   * once `deadlineMs` has passed.
   */
  next(after: number, deadlineMs?: number): Promise<number> {
    if (this.latest > after || this.due(deadlineMs)) return Promise.resolve(this.latest);
    return new Promise((resolve) => {
      this.waiters.push({ after, deadline: deadlineMs, resolve });
      if (!this.running) void this.loop();
    });
  }

  /**
   * Waits for a ledger after the network's current one. It polls once first, because `current`
   * is stale while nobody has been waiting, and a wait on a stale value ends at once.
   */
  async following(deadlineMs?: number): Promise<number> {
    return this.next(await this.poll(), deadlineMs);
  }

  private due(deadlineMs: number | undefined): boolean {
    return deadlineMs !== undefined && this.now() >= deadlineMs;
  }

  private async poll(): Promise<number> {
    try {
      const { sequence } = await this.rpc.getLatestLedger();
      if (sequence > this.latest) this.latest = sequence;
    } catch {
      // A failed poll is retried on the next tick; waiters only care about progress.
    }
    return this.latest;
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.waiters.length > 0) {
        await this.poll();
        const ready = (w: (typeof this.waiters)[number]) =>
          this.latest > w.after || this.due(w.deadline);
        const done = this.waiters.filter(ready);
        this.waiters = this.waiters.filter((w) => !ready(w));
        for (const w of done) w.resolve(this.latest);
        if (this.waiters.length > 0) await this.sleep(this.intervalMs);
      }
    } finally {
      this.running = false;
    }
  }
}
