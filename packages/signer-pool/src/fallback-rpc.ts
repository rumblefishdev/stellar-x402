import { rpc } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "./types.js";

export interface RpcEndpoint {
  /** A label for logs and events, e.g. the provider's name or URL. */
  name: string;
  rpc: SorobanRpc;
}

export interface FallbackRpcOptions {
  /** A call that takes longer counts as a failure of that endpoint. */
  timeoutMs?: number;
  /**
   * How long a read waits for the active endpoint before it asks every other one too (2 s by
   * default): above the p99 of the fast endpoints measured, below the slow one's median (0049).
   */
  hedgeDelayMs?: number;
  /**
   * A read answered first by another endpoint makes it active only if its ledger trails the
   * newest ledger the endpoints last reported by at most this many (2 by default).
   */
  maxLagLedgers?: number;
  /**
   * Called when calls move to another endpoint, after `error` of the one they were on. `by` is the
   * method whose call failed or was answered elsewhere first, or the caller that reported it
   * through {@link FallbackRpc.markFailed}.
   */
  onSwitch?: (from: string, to: string, error: unknown, by: string) => void;
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
 * `cause` is the active endpoint's error.
 */
export class RpcUnavailableError extends Error {
  override readonly name = "RpcUnavailableError";
}

/**
 * A {@link SorobanRpc} over several endpoints, one of them active.
 *
 * Reads that any endpoint may answer (`getLatestLedger`, `getLedgerEntries`, `getFeeStats`) go to
 * the active endpoint, and to every other one too when it has not answered in `hedgeDelayMs` or
 * has failed. The first answer is returned, and its endpoint becomes active unless it trails the
 * others by more than `maxLagLedgers`. So calls stay on the fastest endpoint that keeps up, and
 * never return to the first one by time alone.
 *
 * A transaction's own reads (`simulateTransaction`, `getTransaction`) stay on one endpoint, so
 * the simulation and the status checks see the same node: they go to the active endpoint, and
 * to the next ones in turn only after it throws or times out. The first that answers becomes
 * active. `sendTransaction` is never retried here, because a failed send may still have reached
 * the network. It moves the active endpoint and rethrows, and the submitter decides how to resend
 * (it resends the same envelope and settles uncertainty by hash).
 *
 * If every endpoint fails, the active one stays and an {@link RpcUnavailableError} is thrown with
 * the active endpoint's error as its `cause`. An account that doesn't exist is an answer, not a
 * failure: `getLedgerEntries` returns no entry (see `readAccountEntry`).
 *
 * A response from a lagging endpoint is still correct for the submitter: `NOT_FOUND` carries that
 * endpoint's own latest ledger and close time, so lag cannot report a transaction as expired too
 * early. An endpoint near a bound can miss one that landed in its last ledger, so the submitter
 * trusts `NOT_FOUND` only a margin past either bound, which relies on this class's timeout (0088).
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
  /** Each endpoint's ledger in its last answer that carried one, for the lag check. */
  private readonly lastLedgers: (number | undefined)[];
  private readonly timeoutMs: number;
  private readonly hedgeDelayMs: number;
  private readonly maxLagLedgers: number;

  constructor(
    private readonly endpoints: readonly RpcEndpoint[],
    private readonly opts: FallbackRpcOptions = {},
  ) {
    if (endpoints.length === 0) throw new Error("FallbackRpc needs at least one endpoint");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.hedgeDelayMs = opts.hedgeDelayMs ?? 2_000;
    this.maxLagLedgers = opts.maxLagLedgers ?? 2;
    this.lastLedgers = endpoints.map(() => undefined);
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

  /** The endpoint a call starts on, with its token. */
  begin(): ActiveEndpoint {
    return { index: this.current, token: this.generation };
  }

  /**
   * A call on endpoint `index` that began at `token` failed, made by a caller that reaches the
   * endpoints another way (`by` names it): calls move to the next endpoint, unless they moved since
   * `token`. Returns the token to report the next endpoint's failure with, or `undefined` if calls
   * had moved or there is no other endpoint, and then the caller reports nothing more for this call.
   */
  markFailed(index: number, token: number, error: unknown, by: string): number | undefined {
    if (this.endpoints.length < 2 || token !== this.generation || index !== this.current) {
      return undefined;
    }
    return this.moveOn(error, by) ? this.generation : undefined;
  }

  getLedgerEntries: SorobanRpc["getLedgerEntries"] = (...a) =>
    this.hedged("getLedgerEntries", (r) => r.getLedgerEntries(...a));
  getLatestLedger: SorobanRpc["getLatestLedger"] = (...a) =>
    this.hedged("getLatestLedger", (r) => r.getLatestLedger(...a));
  getFeeStats: SorobanRpc["getFeeStats"] = (...a) =>
    this.hedged("getFeeStats", (r) => r.getFeeStats(...a));
  simulateTransaction: SorobanRpc["simulateTransaction"] = (...a) =>
    this.inTurn("simulateTransaction", (r) => r.simulateTransaction(...a));
  getTransaction: SorobanRpc["getTransaction"] = (...a) =>
    this.inTurn("getTransaction", (r) => r.getTransaction(...a));

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

  /**
   * Asks the active endpoint, and every other one at once after `hedgeDelayMs` or its failure;
   * returns the first answer. Losing requests run on to their own timeout, unread.
   */
  private hedged<T>(by: string, fn: (r: SorobanRpc) => Promise<T>): Promise<T> {
    const { index: start, token } = this.begin();
    const errors = new Map<number, unknown>();
    let asked = 0;
    let failed = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<T>((resolve, reject) => {
      const ask = (i: number) => {
        asked++;
        // A client that throws before its promise is a failure too, not a crash of the timer.
        this.withTimeout(new Promise<T>((r) => r(fn(this.endpoints[i]!.rpc)))).then(
          (answer) => {
            this.lastLedgers[i] = ledgerOf(answer) ?? this.lastLedgers[i];
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (i !== start) this.promote(i, token, errors.get(start), by);
            resolve(answer);
          },
          (error: unknown) => {
            errors.set(i, error);
            failed++;
            if (done) return;
            if (i === start) askOthers();
            if (failed === this.endpoints.length) {
              done = true;
              reject(unavailable(errors.get(start)));
            }
          },
        );
      };
      const askOthers = () => {
        if (asked > 1) return;
        clearTimeout(timer);
        this.endpoints.forEach((_, i) => i !== start && ask(i));
      };
      if (this.endpoints.length > 1) timer = setTimeout(askOthers, this.hedgeDelayMs);
      ask(start);
    });
  }

  /**
   * Makes `winner` active after it answered before the active endpoint, unless calls moved since
   * the read began or it trails the newest ledger the endpoints last reported by more than
   * `maxLagLedgers`: a fast node that is behind would show the network as it was.
   */
  private promote(winner: number, token: number, error: unknown, by: string): void {
    if (this.generation !== token) return;
    const ledger = this.lastLedgers[winner];
    const newest = Math.max(...this.lastLedgers.map((l) => l ?? -Infinity));
    if (ledger !== undefined && newest - ledger > this.maxLagLedgers) return;
    const reason = error ?? new RpcTimeoutError(`no answer within ${this.hedgeDelayMs} ms`);
    this.switchTo(winner, reason, by);
  }

  /** Asks the active endpoint, then the next ones in turn after a failure. */
  private async inTurn<T>(by: string, fn: (r: SorobanRpc) => Promise<T>): Promise<T> {
    const { index: start, token } = this.begin();
    let firstError: unknown;
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (start + i) % this.endpoints.length;
      try {
        const result = await this.withTimeout(fn(this.endpoints[idx]!.rpc));
        if (idx !== start && this.generation === token) this.switchTo(idx, firstError, by);
        return result;
      } catch (error) {
        if (i === 0) firstError = error;
      }
    }
    throw unavailable(firstError);
  }

  /** Moves calls to the next endpoint after the active one's failure; says whether they moved. */
  private moveOn(error: unknown, by: string): boolean {
    const next = (this.current + 1) % this.endpoints.length;
    if (next === this.current) return false;
    this.switchTo(next, error, by);
    return true;
  }

  private switchTo(idx: number, error: unknown, by: string): void {
    const from = this.current;
    this.current = idx;
    this.generation++;
    const [fromName, toName] = [this.endpoints[from]!.name, this.active];
    notify(() => this.opts.onSwitch?.(fromName, toName, error, by));
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

function unavailable(cause: unknown): RpcUnavailableError {
  // `rpc.Server` throws a JSON-RPC error answer as the plain `{ code, message }` object.
  const message = cause instanceof Error ? cause.message : JSON.stringify(cause);
  return new RpcUnavailableError(`every RPC endpoint failed: ${message}`, { cause });
}

/**
 * The ledger an answer was read at: `getLatestLedger` gives `sequence`, `getLedgerEntries` and
 * `getFeeStats` give `latestLedger`.
 */
function ledgerOf(answer: unknown): number | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const { latestLedger, sequence } = answer as { latestLedger?: unknown; sequence?: unknown };
  const ledger = latestLedger ?? sequence;
  return typeof ledger === "number" ? ledger : undefined;
}

/** Hooks only log; one that throws must not turn an answer into a failure. */
function notify(hook: () => void): void {
  try {
    hook();
  } catch {
    // A failing logger has nowhere to report to.
  }
}
