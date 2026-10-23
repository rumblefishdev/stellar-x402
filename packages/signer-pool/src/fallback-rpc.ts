import { rpc } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "./types.js";

/** A probe started at once, after a failure, waits this long after the last one began. */
const MIN_PROBE_GAP_MS = 5_000;

export interface RpcEndpoint {
  /** A label for logs and events, e.g. the provider's name or URL. */
  name: string;
  rpc: SorobanRpc;
}

export interface FallbackRpcOptions {
  /** A call that takes longer counts as a failure of that endpoint. */
  timeoutMs?: number;
  /**
   * Called when calls move to another endpoint, after `error` of the one they were on. `by` is the
   * method whose call failed, or the caller that reported it through {@link FallbackRpc.markFailed}.
   */
  onSwitch?: (from: string, to: string, error: unknown, by: string) => void;
  /**
   * Return to the first endpoint while calls are off it. A call that finds a probe due starts one
   * beside it, without waiting: the latest ledger of the first endpoint and of the active one, each
   * within `timeoutMs`. Calls go back only if the first answers and trails the active one by at
   * most `maxLagLedgers` (2 by default); an active endpoint that can't read its own ledger is no
   * reason to stay on it. The first probe is due `intervalMs` (60 s by default) after calls left
   * the first endpoint, and the next one `intervalMs` after it began. Only the probe returns calls
   * to the first endpoint: a failure of the last one moves them to the next fallback, or, with none
   * left, keeps them where they are and makes a probe due at once. A call that wraps around to the
   * first endpoint returns its answer and counts as that failure, since the first can answer while
   * it trails. A probe due at once waits 5 s after the last one began. Without `failback`, calls
   * stay where they moved: a failure of the last endpoint moves them to the first, and a call
   * that wraps around, to the endpoint that answered.
   */
  failback?: { intervalMs?: number; maxLagLedgers?: number };
  /** A probe found the first endpoint healthy, and calls went back to it. */
  onFailback?: (from: string, to: string, lagLedgers: number) => void;
  /** A probe found the first endpoint down, or trailing by more than `maxLagLedgers`. */
  onProbeFailed?: (name: string, failure: { error: unknown } | { lagLedgers: number }) => void;
  now?: () => number;
}

/** The endpoint calls go to, and the token that {@link FallbackRpc.markFailed} checks. */
export interface ActiveEndpoint {
  index: number;
  token: number;
}

export class RpcTimeoutError extends Error {
  override readonly name = "RpcTimeoutError";
}

/**
 * Every endpoint failed one call: refused the connection, answered an error status, or timed out.
 * `cause` is the first endpoint's error.
 */
export class RpcUnavailableError extends Error {
  override readonly name = "RpcUnavailableError";
}

/**
 * A {@link SorobanRpc} over several endpoints. Calls go to the active endpoint; when it throws
 * or times out, the same call is tried on the next ones, and the first that answers becomes
 * active (with `failback`, the first endpoint only through its probe). If every endpoint fails,
 * the active one stays and an {@link RpcUnavailableError} is thrown with the first error as its
 * `cause`. An account that doesn't exist is an answer, not a failure: `getLedgerEntries` returns
 * no entry (see `readAccountEntry`).
 *
 * `sendTransaction` is the exception: it is never retried here, because a failed send may still
 * have reached the network. It moves the active endpoint and rethrows, and the submitter decides
 * how to resend (it resends the same envelope and settles uncertainty by hash).
 *
 * A response from a lagging endpoint is still correct for the submitter: `NOT_FOUND` carries that
 * endpoint's own latest close time, so it cannot report a transaction as expired too early.
 *
 * The active endpoint can be shared: a caller that reaches the same URLs another way, in the same
 * order, starts on {@link begin}'s endpoint and reports a failure there with {@link markFailed}, so
 * one outage moves both once. A call only moves the active endpoint if no other call moved it since
 * this call began (a switch counter, the token), so a late answer can't switch back, even after
 * A → B → A.
 */
export class FallbackRpc implements SorobanRpc {
  private current = 0;
  /** Counts switches, so a call can tell whether another one switched while it ran. */
  private generation = 0;
  /** When the next probe of the first endpoint is due, while calls are off it. */
  private nextProbeAt = Infinity;
  /** When the last probe began, so probes started at once stay `MIN_PROBE_GAP_MS` apart. */
  private lastProbeAt = -Infinity;
  private probing = false;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly endpoints: readonly RpcEndpoint[],
    private readonly opts: FallbackRpcOptions = {},
  ) {
    if (endpoints.length === 0) throw new Error("FallbackRpc needs at least one endpoint");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** One endpoint per URL, using `rpc.Server` (http URLs allowed for local nodes). */
  static fromUrls(urls: readonly string[], opts?: FallbackRpcOptions): FallbackRpc {
    return new FallbackRpc(
      urls.map((url) => ({
        name: url,
        rpc: new rpc.Server(url, { allowHttp: url.startsWith("http:") }),
      })),
      opts,
    );
  }

  /** Name of the endpoint calls go to now. */
  get active(): string {
    return this.endpoints[this.current]!.name;
  }

  /** The endpoint a call starts on, with its token. Starts a due probe beside the call. */
  begin(): ActiveEndpoint {
    this.maybeProbe();
    return { index: this.current, token: this.generation };
  }

  /**
   * A call on endpoint `index` that began at `token` failed, made by a caller that reaches the
   * endpoints another way (`by` names it): calls move to the next endpoint, unless they moved since
   * `token`. Returns the token to report the next endpoint's failure with, or `undefined` if calls
   * had moved or stayed (see {@link FallbackRpcOptions.failback}), and then the caller reports
   * nothing more for this call.
   */
  markFailed(index: number, token: number, error: unknown, by: string): number | undefined {
    if (this.endpoints.length < 2 || token !== this.generation || index !== this.current) {
      return undefined;
    }
    return this.moveOn(error, by) ? this.generation : undefined;
  }

  getLedgerEntries: SorobanRpc["getLedgerEntries"] = (...a) =>
    this.call("getLedgerEntries", (r) => r.getLedgerEntries(...a));
  simulateTransaction: SorobanRpc["simulateTransaction"] = (...a) =>
    this.call("simulateTransaction", (r) => r.simulateTransaction(...a));
  getTransaction: SorobanRpc["getTransaction"] = (...a) =>
    this.call("getTransaction", (r) => r.getTransaction(...a));
  getLatestLedger: SorobanRpc["getLatestLedger"] = (...a) =>
    this.call("getLatestLedger", (r) => r.getLatestLedger(...a));
  getFeeStats: SorobanRpc["getFeeStats"] = (...a) =>
    this.call("getFeeStats", (r) => r.getFeeStats(...a));

  sendTransaction: SorobanRpc["sendTransaction"] = async (...a) => {
    const { index: from, token } = this.begin();
    try {
      return await this.withTimeout(this.endpoints[from]!.rpc.sendTransaction(...a));
    } catch (error) {
      if (this.endpoints.length > 1 && this.generation === token) {
        this.moveOn(error, "sendTransaction");
      }
      throw error;
    }
  };

  private async call<T>(by: string, fn: (r: SorobanRpc) => Promise<T>): Promise<T> {
    const { index: start, token } = this.begin();
    let firstError: unknown;
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (start + i) % this.endpoints.length;
      try {
        const result = await this.withTimeout(fn(this.endpoints[idx]!.rpc));
        if (idx !== start && this.generation === token) {
          // An answer says the first endpoint is up, not that it is caught up: the probe decides.
          if (this.opts.failback && idx === 0) this.moveOn(firstError, by);
          else this.switchTo(idx, firstError, by);
        }
        return result;
      } catch (error) {
        if (i === 0) firstError = error;
      }
    }
    // `rpc.Server` throws a JSON-RPC error answer as the plain `{ code, message }` object.
    const message = firstError instanceof Error ? firstError.message : JSON.stringify(firstError);
    throw new RpcUnavailableError(`every RPC endpoint failed: ${message}`, { cause: firstError });
  }

  /**
   * Moves calls past the active endpoint after its failure, and says whether they moved. With
   * `failback` they never move to the first endpoint, whose return is the probe's alone: a dead
   * first endpoint would otherwise be back after one failure of the last one (AD-3).
   */
  private moveOn(error: unknown, by: string): boolean {
    let next = (this.current + 1) % this.endpoints.length;
    if (this.opts.failback && next === 0) next = 1;
    if (next === this.current) {
      this.probeNow();
      return false;
    }
    this.switchTo(next, error, by);
    return true;
  }

  /**
   * Makes a probe of the first endpoint due at once, or `MIN_PROBE_GAP_MS` after the last one
   * began, and starts it unless one is running: a URL that keeps failing calls starts one probe
   * per gap, not one per call.
   */
  private probeNow(): void {
    const at = Math.max(this.now(), this.lastProbeAt + MIN_PROBE_GAP_MS);
    this.nextProbeAt = Math.min(this.nextProbeAt, at);
    this.maybeProbe();
  }

  private switchTo(idx: number, error: unknown, by: string): void {
    const from = this.current;
    this.current = idx % this.endpoints.length;
    this.generation++;
    // Probes run only while calls are off the first endpoint; a switch between the others keeps
    // the time of the next one.
    if (this.current === 0) this.nextProbeAt = Infinity;
    else if (from === 0) this.nextProbeAt = this.now() + this.probeIntervalMs;
    const [fromName, toName] = [this.endpoints[from]!.name, this.active];
    notify(() => this.opts.onSwitch?.(fromName, toName, error, by));
  }

  private get probeIntervalMs(): number {
    return this.opts.failback?.intervalMs ?? 60_000;
  }

  private maybeProbe(): void {
    if (!this.opts.failback || this.current === 0 || this.probing) return;
    if (this.now() < this.nextProbeAt) return;
    this.probing = true;
    this.lastProbeAt = this.now();
    this.nextProbeAt = this.now() + this.probeIntervalMs;
    void this.probe().finally(() => (this.probing = false));
  }

  private async probe(): Promise<void> {
    const from = this.current;
    const atStart = this.generation;
    const first = this.endpoints[0]!.name;
    const ledger = async (i: number) =>
      (await this.withTimeout(this.endpoints[i]!.rpc.getLatestLedger())).sequence;
    const [primary, active] = await Promise.allSettled([ledger(0), ledger(from)]);
    if (primary.status === "rejected") {
      notify(() => this.opts.onProbeFailed?.(first, { error: primary.reason }));
      return;
    }
    // An active endpoint that can't say its ledger is no reason to stay on it.
    const lagLedgers =
      active.status === "fulfilled" ? Math.max(0, active.value - primary.value) : 0;
    if (lagLedgers > (this.opts.failback?.maxLagLedgers ?? 2)) {
      notify(() => this.opts.onProbeFailed?.(first, { lagLedgers }));
      return;
    }
    if (this.generation !== atStart) return;
    this.current = 0;
    this.generation++;
    this.nextProbeAt = Infinity;
    notify(() => this.opts.onFailback?.(this.endpoints[from]!.name, first, lagLedgers));
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RpcTimeoutError(`no answer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}

/** Hooks only log; one that throws must not turn an answer into a failure. */
function notify(hook: () => void): void {
  try {
    hook();
  } catch {
    // A failing logger has nowhere to report to.
  }
}
