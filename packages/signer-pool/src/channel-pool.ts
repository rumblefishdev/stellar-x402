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
   * was still pending: the sequence number that transaction uses, and a promise that settles once
   * it is final. The next holder reads `sequence` only after `final`.
   */
  pending?: { sequence: bigint; final: Promise<void> };
}

/**
 * Hands out channels one holder at a time. Stellar-core keeps at most one pending transaction
 * per source account, so a channel is held from build until its transaction is final.
 * Waiters are served first in, first out.
 */
export class ChannelPool {
  private readonly free: Channel[];
  private readonly waiters: ((channel: Channel) => void)[] = [];
  private readonly all: readonly Channel[];

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

  /** Callers waiting for a channel. */
  get queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<Channel> {
    const channel = this.free.shift();
    if (channel) return Promise.resolve(channel);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Gives a held channel to the next waiter before the holder is done (pipelining). The holder
   * keeps confirming its transaction but must not release the channel; the new holder does.
   */
  handOver(channel: Channel): void {
    if (!this.all.includes(channel)) throw new Error(`unknown channel ${channel.address}`);
    const next = this.waiters.shift();
    if (!next) throw new Error("no waiter to hand the channel to");
    next(channel);
  }

  release(channel: Channel): void {
    if (!this.all.includes(channel)) throw new Error(`unknown channel ${channel.address}`);
    if (this.free.includes(channel)) throw new Error(`channel ${channel.address} released twice`);
    const next = this.waiters.shift();
    if (next) next(channel);
    else this.free.push(channel);
  }
}
