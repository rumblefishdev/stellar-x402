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
  /** Called when calls move to another endpoint. */
  onSwitch?: (from: string, to: string, error: unknown) => void;
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
 * active. If every endpoint fails, the active one stays and an {@link RpcUnavailableError} is
 * thrown with the first error as its `cause`. An account that doesn't exist is an answer, not a
 * failure: `getLedgerEntries` returns no entry (see `readAccountEntry`).
 *
 * `sendTransaction` is the exception: it is never retried here, because a failed send may still
 * have reached the network. It moves the active endpoint and rethrows, and the submitter decides
 * how to resend (it resends the same envelope and settles uncertainty by hash).
 *
 * A response from a lagging endpoint is still correct for the submitter: `NOT_FOUND` carries that
 * endpoint's own latest close time, so it cannot report a transaction as expired too early.
 */
export class FallbackRpc implements SorobanRpc {
  private current = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoints: readonly RpcEndpoint[],
    private readonly opts: FallbackRpcOptions = {},
  ) {
    if (endpoints.length === 0) throw new Error("FallbackRpc needs at least one endpoint");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
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

  getLedgerEntries: SorobanRpc["getLedgerEntries"] = (...a) =>
    this.call((r) => r.getLedgerEntries(...a));
  simulateTransaction: SorobanRpc["simulateTransaction"] = (...a) =>
    this.call((r) => r.simulateTransaction(...a));
  getTransaction: SorobanRpc["getTransaction"] = (...a) => this.call((r) => r.getTransaction(...a));
  getLatestLedger: SorobanRpc["getLatestLedger"] = (...a) =>
    this.call((r) => r.getLatestLedger(...a));
  getFeeStats: SorobanRpc["getFeeStats"] = (...a) => this.call((r) => r.getFeeStats(...a));

  sendTransaction: SorobanRpc["sendTransaction"] = async (...a) => {
    const from = this.current;
    try {
      return await this.withTimeout(this.endpoints[from]!.rpc.sendTransaction(...a));
    } catch (error) {
      if (this.endpoints.length > 1 && this.current === from) this.switchTo(from + 1, error);
      throw error;
    }
  };

  private async call<T>(fn: (r: SorobanRpc) => Promise<T>): Promise<T> {
    const start = this.current;
    let firstError: unknown;
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (start + i) % this.endpoints.length;
      try {
        const result = await this.withTimeout(fn(this.endpoints[idx]!.rpc));
        if (idx !== this.current) this.switchTo(idx, firstError);
        return result;
      } catch (error) {
        if (i === 0) firstError = error;
      }
    }
    // `rpc.Server` throws a JSON-RPC error answer as the plain `{ code, message }` object.
    const message = firstError instanceof Error ? firstError.message : JSON.stringify(firstError);
    throw new RpcUnavailableError(`every RPC endpoint failed: ${message}`, { cause: firstError });
  }

  private switchTo(idx: number, error: unknown): void {
    const from = this.active;
    this.current = idx % this.endpoints.length;
    this.opts.onSwitch?.(from, this.active, error);
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
