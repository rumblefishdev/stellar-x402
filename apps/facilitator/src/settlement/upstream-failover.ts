import type { VerifyResponse } from "@x402/core/types";
import { UNEXPECTED_VERIFY_ERROR, withTimeout, type UpstreamVerifier } from "./verify.js";

export interface UpstreamEndpoint {
  /** A label for `onSwitch`. Not the URL: an RPC URL can carry an API key. */
  name: string;
  verifier: UpstreamVerifier;
}

export interface UpstreamFailoverOptions {
  /** How long one endpoint's `verify()` may take, in milliseconds; 10,000 by default. */
  timeoutMs?: number;
  /** Called when calls move to another endpoint. */
  onSwitch?: (from: string, to: string) => void;
}

/**
 * Upstream `verify()` over one `ExactStellarScheme` per `RPC_URLS` entry, the way `FallbackRpc`
 * fails over: calls go to the active endpoint, and the same call is tried on the next ones when it
 * throws, takes longer than `timeoutMs`, or answers `unexpected_verify_error` (upstream's answer
 * to its own exceptions, such as a failed RPC call). The first endpoint with any other answer,
 * valid or not, becomes active. If every endpoint fails, the first failure is the result: the
 * error is thrown, or the `unexpected_verify_error` answer returned, for `createVerifier`'s 500.
 *
 * A call cut off by `timeoutMs` keeps running: upstream's clients can't be cancelled. Verifying
 * sends nothing, so trying it again elsewhere is safe.
 */
export function failoverUpstream(
  endpoints: readonly UpstreamEndpoint[],
  opts: UpstreamFailoverOptions = {},
): UpstreamVerifier {
  if (endpoints.length === 0) throw new Error("failoverUpstream needs at least one endpoint");
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let current = 0;
  return {
    async verify(payload, requirements) {
      const start = current;
      let first: { error: unknown } | { answer: VerifyResponse } | undefined;
      for (let i = 0; i < endpoints.length; i++) {
        const idx = (start + i) % endpoints.length;
        try {
          const answer = await withTimeout(
            endpoints[idx]!.verifier.verify(payload, requirements),
            timeoutMs,
          );
          if (answer.invalidReason !== UNEXPECTED_VERIFY_ERROR) {
            if (idx !== current) {
              const from = endpoints[current]!.name;
              current = idx;
              opts.onSwitch?.(from, endpoints[idx]!.name);
            }
            return answer;
          }
          first ??= { answer };
        } catch (error) {
          first ??= { error };
        }
      }
      if (first && "answer" in first) return first.answer;
      throw first?.error;
    },
  };
}
