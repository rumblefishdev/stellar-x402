/**
 * A channel account: an account the facilitator controls (its key is a signer on it) that serves
 * only as a transaction source, so each one carries an independent sequence number.
 */
export interface Channel {
  readonly address: string;
  /**
   * The account's current sequence number as we know it, or `undefined` when it must be read
   * from the network before the next build. Only the holder of the channel touches it.
   */
  sequence: bigint | undefined;
  /**
   * Set when the channel was handed to its next holder while the previous holder's transaction
   * was still pending: the sequence number that transaction uses, a promise that settles once it
   * is final, and when its holder reports `pending` if it is not (ms). The next holder reads
   * `sequence` only after `final`.
   */
  pending?: { sequence: bigint; final: Promise<void>; dueAt: number };
}

/** No channel became free in time; nothing was sent. */
export class QueueTimeoutError extends Error {
  override readonly name = "QueueTimeoutError";
}

/** Every channel was taken out of the pool; nothing was sent. */
export class NoChannelsError extends Error {
  override readonly name = "NoChannelsError";
}

/** The submitter is closing (`close()`); this call sent nothing. */
export class ShutdownError extends Error {
  override readonly name = "ShutdownError";
}

interface Waiter {
  resolve: (channel: Channel) => void;
  reject: (error: Error) => void;
}

/**
 * Hands out channels one holder at a time. Stellar-core keeps at most one pending transaction
 * per source account, so a channel is held from build until its transaction is final.
 * Waiters are served first in, first out.
 */
export class ChannelPool {
  private readonly free: Channel[];
  private readonly waiters: Waiter[] = [];
  private readonly all: Channel[];
  /** How many holds ({@link hold}) each channel is under; absent while it is under none. */
  private readonly holds = new Map<Channel, number>();
  /** Channels under a hold that no caller holds: out of `free` until their last hold ends. */
  private readonly parked = new Set<Channel>();
  private closed = false;

  constructor(addresses: readonly string[]) {
    if (addresses.length === 0) throw new Error("ChannelPool needs at least one channel");
    if (new Set(addresses).size !== addresses.length) throw new Error("duplicate channel address");
    this.all = addresses.map((address) => ({ address, sequence: undefined }));
    this.free = [...this.all];
  }

  get size(): number {
    return this.all.length;
  }

  get busy(): number {
    return this.all.length - this.free.length;
  }

  /** Channels under a hold ({@link hold}), with a caller or without. */
  get held(): number {
    return this.holds.size;
  }

  /** Callers waiting for a channel. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Resolves with a free channel, or waits for one. When the caller has to wait, `onWait` is
   * called; if the promise it returns settles before a channel is handed out, the wait ends with
   * a {@link QueueTimeoutError}.
   */
  acquire(onWait?: () => Promise<unknown>): Promise<Channel> {
    if (this.closed) return Promise.reject(new ShutdownError("the channel pool is closed"));
    const channel = this.free.shift();
    if (channel) return Promise.resolve(channel);
    if (this.all.length === 0) return Promise.reject(new NoChannelsError("no channels left"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      void onWait?.().then(() => {
        const i = this.waiters.indexOf(waiter);
        if (i < 0) return; // a channel was handed out first
        this.waiters.splice(i, 1);
        reject(new QueueTimeoutError("no channel became free before the deadline"));
      });
    });
  }

  /**
   * Takes a held channel out of the pool for good, e.g. one that can no longer be read. When the
   * last channel goes, every waiter fails with {@link NoChannelsError}.
   */
  retire(channel: Channel): void {
    const i = this.all.indexOf(channel);
    if (i < 0) throw new Error(`unknown channel ${channel.address}`);
    if (this.free.includes(channel) || this.parked.has(channel))
      throw new Error(`channel ${channel.address} is not held`);
    this.all.splice(i, 1);
    if (this.all.length === 0)
      for (const w of this.waiters.splice(0)) w.reject(new NoChannelsError("no channels left"));
  }

  /**
   * Gives a held channel to the next waiter before the holder is done (pipelining). The holder
   * keeps confirming its transaction but must not release the channel; the new holder does.
   */
  handOver(channel: Channel): void {
    if (!this.all.includes(channel)) throw new Error(`unknown channel ${channel.address}`);
    if (this.holds.has(channel)) throw new Error(`channel ${channel.address} is under a hold`);
    const next = this.waiters.shift();
    if (!next) throw new Error("no waiter to hand the channel to");
    next.resolve(channel);
  }

  /** Whether the channel is under a hold, so its holder must release it, not hand it over. */
  isHeld(channel: Channel): boolean {
    return this.holds.has(channel);
  }

  /**
   * Keeps the channel at `address` from every caller until `until` settles, fulfilled or rejected,
   * e.g. while another process's transaction on it may still land (0090). A free channel leaves the
   * pool at once; a held one when its holder releases it. Holds stack: the channel comes back once
   * the last one ends, to the next waiter or the free list.
   */
  hold(address: string, until: Promise<unknown>): void {
    const channel = this.all.find((c) => c.address === address);
    if (!channel) throw new Error(`unknown channel ${address}`);
    this.holds.set(channel, (this.holds.get(channel) ?? 0) + 1);
    const i = this.free.indexOf(channel);
    if (i >= 0) {
      this.free.splice(i, 1);
      this.parked.add(channel);
    }
    const end = () => {
      const left = this.holds.get(channel)! - 1;
      if (left > 0) return void this.holds.set(channel, left);
      this.holds.delete(channel);
      // Still with a caller: its release() returns it.
      if (!this.parked.delete(channel)) return;
      // The transaction held for may have used the sequence number: read it again (0090).
      channel.sequence = undefined;
      this.giveBack(channel);
    };
    until.then(end, end);
  }

  /**
   * Refuses every waiter and every later `acquire()` with {@link ShutdownError}. Held channels
   * stay with their holders, which may still release or hand them over.
   */
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0))
      w.reject(new ShutdownError("the channel pool is closed"));
  }

  release(channel: Channel): void {
    if (!this.all.includes(channel)) throw new Error(`unknown channel ${channel.address}`);
    if (this.free.includes(channel) || this.parked.has(channel))
      throw new Error(`channel ${channel.address} released twice`);
    if (this.holds.has(channel)) return void this.parked.add(channel);
    this.giveBack(channel);
  }

  private giveBack(channel: Channel): void {
    const next = this.waiters.shift();
    if (next) next.resolve(channel);
    else this.free.push(channel);
  }
}
