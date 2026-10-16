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
   * The latest ledger of endpoint `i`, read from its own RPC with no client payload. Without it,
   * calls never return to the first endpoint on their own.
   */
  latestLedger?: (index: number) => Promise<number>;
  /**
   * How often the first endpoint is probed while calls are off it, in milliseconds; 60,000 by
   * default. The first probe is due this long after calls left it.
   */
  probeIntervalMs?: number;
  /** How many ledgers the first endpoint may trail the active one by and still be returned to. */
  maxLagLedgers?: number;
  /** Calls moved to another endpoint, after `failure` of the endpoint they were on. */
  onSwitch?: (from: string, to: string, failure: EndpointFailure) => void;
  /** A probe found the first endpoint healthy, and calls went back to it. */
  onFailback?: (from: string, to: string, lagLedgers: number) => void;
  /** A probe found the first endpoint down, or trailing by more than `maxLagLedgers`. */
  onProbeFailed?: (name: string, failure: { error: unknown } | { lagLedgers: number }) => void;
  /** Every endpoint failed for one call, in the order tried. */
  onExhausted?: (tried: readonly { name: string; failure: EndpointFailure }[]) => void;
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
 * ledger and fee-stats reads. A call only moves it if no other call has moved it since this call
 * began (a switch counter, so a late answer can't switch back, even after A → B → A).
 *
 * While calls are off the first endpoint, a call that finds a probe due starts one without
 * waiting for it: `latestLedger` of the first endpoint and of the active one, each within
 * `timeoutMs`. Calls go back to the first endpoint only if it answers and trails the active one
 * by at most `maxLagLedgers`. A client's payload never decides it: upstream refuses many payloads
 * before any RPC call, so a payload answer says nothing about the RPC.
 *
 * `endpoints` is read once per call, before any endpoint's timer starts: with fee-stats bids it
 * reads the bid (AD-10) and returns one scheme per URL built for it. It must return the same
 * endpoints in the same order on every call. The name of the endpoint that answered goes in
 * `trace.rpc`.
 *
 * A call cut off by `timeoutMs` keeps running: upstream's clients can't be cancelled. Verifying
 * sends nothing, so trying it again elsewhere is safe; `main()` bounds the abandoned HTTP requests
 * with undici's global timeouts.
 */
export function failoverUpstream(
  endpoints: () => Promise<readonly UpstreamEndpoint[]>,
  opts: UpstreamFailoverOptions = {},
): UpstreamVerifier {
  const { timeoutMs = 10_000, probeIntervalMs = 60_000, maxLagLedgers = 2, now = Date.now } = opts;
  let current = 0;
  /** Counts switches, so a call can tell whether another one switched while it ran. */
  let generation = 0;
  /** When the next probe of the first endpoint is due, while calls are off it. */
  let nextProbeAt = Infinity;
  let probing = false;

  /** Hooks only log; one that throws must not turn an answer into a failure. */
  const notify = (hook: () => void) => {
    try {
      hook();
    } catch {
      // A failing logger has nowhere to report to.
    }
  };

  const probe = async (list: readonly UpstreamEndpoint[]) => {
    const latestLedger = opts.latestLedger!;
    const from = current;
    const atStart = generation;
    const [primary, active] = await Promise.allSettled([
      withTimeout(latestLedger(0), timeoutMs, `${list[0]!.name}: latest ledger`),
      withTimeout(latestLedger(from), timeoutMs, `${list[from]!.name}: latest ledger`),
    ]);
    if (primary.status === "rejected") {
      notify(() => opts.onProbeFailed?.(list[0]!.name, { error: primary.reason }));
      return;
    }
    // An active endpoint that can't say its ledger is no reason to stay on it.
    const lagLedgers =
      active.status === "fulfilled" ? Math.max(0, active.value - primary.value) : 0;
    if (lagLedgers > maxLagLedgers) {
      notify(() => opts.onProbeFailed?.(list[0]!.name, { lagLedgers }));
      return;
    }
    if (generation !== atStart) return;
    current = 0;
    generation++;
    nextProbeAt = Infinity;
    notify(() => opts.onFailback?.(list[from]!.name, list[0]!.name, lagLedgers));
  };

  const maybeProbe = (list: readonly UpstreamEndpoint[]) => {
    if (!opts.latestLedger || current === 0 || probing || now() < nextProbeAt) return;
    probing = true;
    nextProbeAt = now() + probeIntervalMs;
    void probe(list).finally(() => (probing = false));
  };

  return {
    async verify(payload, requirements, trace) {
      const list = await endpoints();
      if (list.length === 0) throw new Error("failoverUpstream needs at least one endpoint");
      maybeProbe(list);
      const active = current;
      const atStart = generation;
      const tried: { name: string; failure: EndpointFailure }[] = [];
      for (let i = 0; i < list.length; i++) {
        const idx = (active + i) % list.length;
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
          continue;
        }
        if (answer.invalidReason === UNEXPECTED_VERIFY_ERROR) {
          tried.push({ name, failure: { answer } });
          continue;
        }
        if (idx !== active && generation === atStart) {
          current = idx;
          generation++;
          // Probes run only while calls are off the first endpoint.
          if (active === 0) nextProbeAt = now() + probeIntervalMs;
          notify(() => opts.onSwitch?.(list[active]!.name, name, tried[0]!.failure));
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
