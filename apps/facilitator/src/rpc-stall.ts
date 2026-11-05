import { unrefTimers, type Scheduler } from "./timers.js";

/** How often the tracker reads the latest ledger by default. */
export const RPC_STALL_POLL_MS = 30_000;

/** The shared client as the tracker reads it: `FallbackRpc` fits. */
export interface StallRpc {
  /** The active endpoint's name; a plain read. */
  readonly active: string;
  getLatestLedger(): Promise<{ sequence: number }>;
}

export interface RpcStallTracker {
  /** Reads now, then every `RPC_STALL_POLL_MS` until `stop()`. A second call does nothing. */
  start(): void;
  /** Ends the ticks; a read still under way lands unrecorded. */
  stop(): void;
  /** Seconds since the sequence last changed, taken at the call (0027 AD-5). */
  stalledSeconds(): number;
}

/**
 * `rpc_stalled_seconds` (0027 AD-5): the time since the ledger sequence last changed, read every
 * `RPC_STALL_POLL_MS` through the shared `FallbackRpc`, so it measures what settlement sees; a failed read
 * can move the active endpoint, which is accepted. The age is `now − lastChangeAt` at the read, so
 * a frozen endpoint, failing reads or a dead poller all show as a rising value. A different active
 * endpoint or a lower sequence (a lagging fallback, testnet's reset) starts a new baseline. Before
 * the first good read the age counts from `start()`. A tick that finds a read still under way is
 * skipped, so reads never stack. Pure at the read: `stalledSeconds()` makes no call.
 */
export function createRpcStallTracker(deps: {
  rpc: StallRpc;
  now: () => number;
  schedule?: Scheduler;
}): RpcStallTracker {
  const { rpc, now } = deps;
  const schedule = deps.schedule ?? unrefTimers;
  /** The last good read's sequence and the endpoint that served it. */
  let last: { sequence: number; endpoint: string } | undefined;
  let lastChangeAt = now();
  let reading = false;
  let running = false;
  let timer: unknown;

  async function read() {
    let sequence: number;
    try {
      ({ sequence } = await rpc.getLatestLedger());
    } catch {
      // `FallbackRpc` logs the failover; the age keeps rising.
      return;
    }
    if (!running) return;
    // Read after the call, which may have moved it: the endpoint that answered.
    const endpoint = rpc.active;
    if (last === undefined || endpoint !== last.endpoint || sequence !== last.sequence) {
      lastChangeAt = now();
    }
    last = { sequence, endpoint };
  }

  function tick() {
    if (!running) return;
    timer = schedule.setTimeout(tick, RPC_STALL_POLL_MS);
    if (reading) return;
    reading = true;
    void read().finally(() => {
      reading = false;
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = undefined;
      lastChangeAt = now();
      tick();
    },
    stop() {
      running = false;
      if (timer !== undefined) schedule.clearTimeout(timer);
      timer = undefined;
    },
    stalledSeconds: () => Math.max(0, (now() - lastChangeAt) / 1000),
  };
}
