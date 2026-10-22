import type { FallbackRpc } from "@stellar-x402/signer-pool";
import type { VerifyResponse } from "@x402/core/types";
import { UNEXPECTED_VERIFY_ERROR, withTimeout, type UpstreamVerifier } from "./verify.js";

export interface UpstreamEndpoint {
  /** A label for the logs and the `verified` trace. Not the URL: an RPC URL can carry an API key. */
  name: string;
  verifier: UpstreamVerifier;
}

/** Why an endpoint's call failed: the thrown error, or upstream's `unexpected_verify_error`. */
export type EndpointFailure = { error: unknown } | { answer: VerifyResponse };

export interface UpstreamFailoverOptions {
  /** How long one endpoint's `verify()` may take, in milliseconds; 10,000 by default. */
  timeoutMs?: number;
  /**
   * Which endpoint is active, shared with the pool's `FallbackRpc` over the same `RPC_URLS`, in the
   * same order: a call starts on its endpoint and reports a throw or a timeout there, so one outage
   * moves `/verify`, `/settle`'s checks and the pool once (AD-3).
   */
  active: Pick<FallbackRpc, "begin" | "markFailed">;
  /** Every endpoint failed for one call, in the order tried. */
  onExhausted?: (tried: readonly { name: string; failure: EndpointFailure }[]) => void;
}

/**
 * Upstream `verify()` over one `ExactStellarScheme` per `RPC_URLS` entry. A call starts on the
 * shared active endpoint, and the same call is tried on the next ones when it throws, takes longer
 * than `timeoutMs`, or answers `unexpected_verify_error` (upstream's answer to its own exceptions,
 * such as a failed RPC call). The first endpoint with any other answer, valid or not, answers.
 * If every endpoint fails, the first failure is the result: the error is thrown, or the
 * `unexpected_verify_error` answer returned, for `createVerifier`'s 500.
 *
 * Only a throw or a timeout is reported to the shared state, and moves every caller: a hang is the
 * outage that costs each caller its own timeout. `unexpected_verify_error` moves nothing, since one
 * odd payload can make upstream fail on its own; a refused URL also fails the pool's next read,
 * which moves the state at once. A call never moves the state on an answer either: the shared
 * `FallbackRpc` decides when calls go back to the first endpoint (its probe, AD-3).
 *
 * `endpoints` is read once per call, before the active endpoint is read and before any endpoint's
 * timer starts: with fee-stats bids it reads the bid (AD-10) over the shared `FallbackRpc`, whose
 * own failover then counts for this call too. It must return the same endpoints in the same order
 * on every call. The name of the endpoint that answered goes in `trace.rpc`.
 *
 * A call cut off by `timeoutMs` keeps running: upstream's clients can't be cancelled. Verifying
 * sends nothing, so trying it again elsewhere is safe; `main()` bounds the abandoned HTTP requests
 * with undici's global timeouts.
 */
export function failoverUpstream(
  endpoints: () => Promise<readonly UpstreamEndpoint[]>,
  opts: UpstreamFailoverOptions,
): UpstreamVerifier {
  const { timeoutMs = 10_000 } = opts;

  /** Hooks only log; one that throws must not turn an answer into a failure. */
  const notify = (hook: () => void) => {
    try {
      hook();
    } catch {
      // A failing logger has nowhere to report to.
    }
  };

  return {
    async verify(payload, requirements, trace) {
      const list = await endpoints();
      if (list.length === 0) throw new Error("failoverUpstream needs at least one endpoint");
      const { index: start, token } = opts.active.begin();
      // `undefined` once calls moved without this call: it reports nothing more.
      let reporting: number | undefined = token;
      const tried: { name: string; failure: EndpointFailure }[] = [];
      for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const { name, verifier } = list[idx]!;
        let answer: VerifyResponse;
        try {
          answer = await withTimeout(
            verifier.verify(payload, requirements),
            timeoutMs,
            `${name}: upstream verify`,
          );
        } catch (error) {
          tried.push({ name, failure: { error } });
          if (reporting !== undefined) {
            reporting = opts.active.markFailed(idx, reporting, error, "verify");
          }
          continue;
        }
        if (answer.invalidReason === UNEXPECTED_VERIFY_ERROR) {
          tried.push({ name, failure: { answer } });
          continue;
        }
        if (trace) trace.rpc = name;
        return answer;
      }
      notify(() => opts.onExhausted?.(tried));
      const first = tried[0]!;
      if ("error" in first.failure) throw first.failure.error;
      if (trace) trace.rpc = first.name;
      return first.failure.answer;
    },
  };
}
