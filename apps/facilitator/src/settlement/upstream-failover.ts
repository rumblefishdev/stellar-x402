import type { VerifyResponse } from "@x402/core/types";
import { UNEXPECTED_VERIFY_ERROR, withTimeout, type UpstreamVerifier } from "./verify.js";

export interface UpstreamEndpoint {
  /** A label for `onSwitch` and the `verified` log. Not the URL: an RPC URL can carry an API key. */
  name: string;
  verifier: UpstreamVerifier;
}

export interface UpstreamFailoverOptions {
  /** How long one endpoint's `verify()` may take, in milliseconds; 10,000 by default. */
  timeoutMs?: number;
  /**
   * How long calls stay off the first endpoint, in milliseconds; 60,000 by default. After it, one
   * call tries the first endpoint first again, and it becomes active again if it answers.
   */
  primaryRetryMs?: number;
  /** Called when calls move to another endpoint. */
  onSwitch?: (from: string, to: string) => void;
  now?: () => number;
}

/**
 * Upstream `verify()` over one `ExactStellarScheme` per `RPC_URLS` entry. Calls go to the active
 * endpoint, and the same call is tried on the next ones when it throws, takes longer than
 * `timeoutMs`, or answers `unexpected_verify_error` (upstream's answer to its own exceptions, such
 * as a failed RPC call). The first endpoint with any other answer, valid or not, becomes active.
 * If every endpoint fails, the first failure is the result: the error is thrown, or the
 * `unexpected_verify_error` answer returned, for `createVerifier`'s 500.
 *
 * The active endpoint is this failover's own, separate from `FallbackRpc`'s for the pool and the
 * ledger and fee-stats reads. A call that began before another call switched never switches back
 * when it answers late. Calls return to the first endpoint after `primaryRetryMs`, so one failure
 * of the first doesn't leave `/verify` on a fallback that may lag.
 *
 * `endpoints` is read once per call, before any endpoint's timer starts: with fee-stats bids it
 * reads the bid (AD-10) and returns one scheme per URL built for it. It must return the same
 * endpoints in the same order on every call. The name of the endpoint that answered goes in
 * `trace.rpc`.
 *
 * A call cut off by `timeoutMs` keeps running: upstream's clients can't be cancelled. Verifying
 * sends nothing, so trying it again elsewhere is safe.
 */
export function failoverUpstream(
  endpoints: () => Promise<readonly UpstreamEndpoint[]>,
  opts: UpstreamFailoverOptions = {},
): UpstreamVerifier {
  const { timeoutMs = 10_000, primaryRetryMs = 60_000, now = Date.now } = opts;
  let current = 0;
  /** When calls last left the first endpoint, or last tried it again and failed. */
  let offPrimarySince = 0;
  return {
    async verify(payload, requirements, trace) {
      const list = await endpoints();
      if (list.length === 0) throw new Error("failoverUpstream needs at least one endpoint");
      const active = current;
      const retryPrimary = active !== 0 && now() - offPrimarySince >= primaryRetryMs;
      // One call per interval tries the first endpoint again.
      if (retryPrimary) offPrimarySince = now();
      const start = retryPrimary ? 0 : active;
      let first: { error: unknown } | { answer: VerifyResponse; name: string } | undefined;
      for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const { name, verifier } = list[idx]!;
        try {
          const answer = await withTimeout(verifier.verify(payload, requirements), timeoutMs);
          if (answer.invalidReason !== UNEXPECTED_VERIFY_ERROR) {
            // Only when no other call has switched since this one began.
            if (idx !== active && current === active) {
              current = idx;
              if (idx !== 0) offPrimarySince = now();
              opts.onSwitch?.(list[active]!.name, name);
            }
            if (trace) trace.rpc = name;
            return answer;
          }
          first ??= { answer, name };
        } catch (error) {
          first ??= { error };
        }
      }
      if (first && "answer" in first) {
        if (trace) trace.rpc = first.name;
        return first.answer;
      }
      throw first?.error;
    },
  };
}
