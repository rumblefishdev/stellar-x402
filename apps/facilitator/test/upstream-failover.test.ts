import { FallbackRpc, type SorobanRpc } from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import {
  failoverUpstream,
  type UpstreamEndpoint,
  type UpstreamFailoverOptions,
} from "../src/settlement/upstream-failover.js";
import {
  UpstreamTimeoutError,
  type UpstreamVerifier,
  type VerifyTrace,
} from "../src/settlement/verify.js";

const payload = {} as PaymentPayload;
const requirements = {} as PaymentRequirements;
const valid: VerifyResponse = { isValid: true, payer: "GPAYER" };
const invalid: VerifyResponse = { isValid: false, invalidReason: "invalid_exact_stellar_payload" };
const unexpected: VerifyResponse = { isValid: false, invalidReason: "unexpected_verify_error" };

type Behaviour = VerifyResponse | Error | "hang" | (() => Promise<VerifyResponse>);

/** An endpoint whose `verify()` answers each call with the next behaviour, the last one after. */
function endpoint(name: string, ...behaviours: Behaviour[]) {
  let call = 0;
  const verify = vi.fn<UpstreamVerifier["verify"]>(async () => {
    const behaviour = behaviours[Math.min(call++, behaviours.length - 1)]!;
    if (behaviour === "hang") return new Promise<never>(() => {});
    if (behaviour instanceof Error) throw behaviour;
    if (typeof behaviour === "function") return behaviour();
    return behaviour;
  });
  return { name, verifier: { verify }, verify };
}

/**
 * {@link failoverUpstream} over a fixed list of endpoints, sharing the active one with a
 * `FallbackRpc` over the same names (the pool's, in `main()`). `rpcs` are its clients per name.
 */
function failover(
  endpoints: readonly UpstreamEndpoint[],
  opts: Partial<UpstreamFailoverOptions> = {},
  rpcs: Record<string, SorobanRpc> = {},
) {
  const switches: string[] = [];
  const shared = new FallbackRpc(
    endpoints.map(({ name }) => ({ name, rpc: rpcs[name] ?? ({} as SorobanRpc) })),
    { timeoutMs: 20, onSwitch: (from, to, _error, by) => switches.push(`${from}->${to} by ${by}`) },
  );
  const upstream = failoverUpstream(async () => endpoints, { active: shared, ...opts });
  return { upstream, shared, switches };
}

describe("failoverUpstream", () => {
  it("answers from the active endpoint while it works, and names it in the trace", async () => {
    const a = endpoint("a", valid);
    const b = endpoint("b", valid);
    const { upstream } = failover([a, b]);
    const trace: VerifyTrace = {};
    await expect(upstream.verify(payload, requirements, trace)).resolves.toEqual(valid);
    expect(trace).toEqual({ rpc: "a" });
    expect(b.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", new Error("rpc down")],
    ["takes longer than timeoutMs", "hang"],
  ] as const)(
    "tries the next endpoint when one %s, and moves every caller there",
    async (_, failure) => {
      const a = endpoint("a", failure);
      const b = endpoint("b", valid);
      const { upstream, shared, switches } = failover([a, b], { timeoutMs: 20 });
      const trace: VerifyTrace = {};
      await expect(upstream.verify(payload, requirements, trace)).resolves.toEqual(valid);
      expect(trace).toEqual({ rpc: "b" });
      expect(switches).toEqual(["a->b by verify"]);
      // The pool's next read starts there too, and so does the next verify.
      expect(shared.active).toBe("b");
      await upstream.verify(payload, requirements);
      expect(a.verify).toHaveBeenCalledTimes(1);
      expect(b.verify).toHaveBeenCalledTimes(2);
    },
  );

  it("tries the next endpoint on unexpected_verify_error, but moves nothing (decision 22)", async () => {
    // One odd payload can make upstream fail on its own; it mustn't move the pool.
    const a = endpoint("a", unexpected, valid);
    const b = endpoint("b", valid);
    const { upstream, shared, switches } = failover([a, b]);
    const trace: VerifyTrace = {};
    await expect(upstream.verify(payload, requirements, trace)).resolves.toEqual(valid);
    expect(trace).toEqual({ rpc: "b" });
    expect(switches).toEqual([]);
    expect(shared.active).toBe("a");
    await upstream.verify(payload, requirements, trace);
    expect(trace).toEqual({ rpc: "a" });
  });

  // A lagging RPC answers these for a valid payment; they are still verdicts (decision 3).
  it.each([
    "invalid_exact_stellar_payload",
    "invalid_exact_stellar_payload_simulation_failed",
    "invalid_exact_stellar_signature_expiration_too_far",
  ])("passes on the rejection %s without trying the next endpoint", async (invalidReason) => {
    const rejection: VerifyResponse = { isValid: false, invalidReason };
    const a = endpoint("a", rejection);
    const b = endpoint("b", valid);
    const { upstream } = failover([a, b]);
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(rejection);
    expect(b.verify).not.toHaveBeenCalled();
  });

  it("starts on the endpoint the pool moved to: a hung first URL costs verify nothing", async () => {
    const a = endpoint("a", "hang");
    const b = endpoint("b", valid);
    const down = { getLatestLedger: () => Promise.reject(new Error("down")) } as SorobanRpc;
    const up = { getLatestLedger: async () => ({ sequence: 1 }) } as unknown as SorobanRpc;
    const { upstream, shared, switches } = failover([a, b], {}, { a: down, b: up });
    // The pool's read fails on `a` and moves calls to `b`.
    await shared.getLatestLedger();
    const trace: VerifyTrace = {};
    await expect(upstream.verify(payload, requirements, trace)).resolves.toEqual(valid);
    expect(trace).toEqual({ rpc: "b" });
    expect(a.verify).not.toHaveBeenCalled();
    expect(switches).toEqual(["a->b by getLatestLedger"]);
  });

  it("reads the active endpoint after the endpoints, so a bid read that moved it counts", async () => {
    // With fee-stats bids, `endpoints` reads the bid over the shared client first (AD-10).
    const a = endpoint("a", "hang");
    const b = endpoint("b", valid);
    const switches: string[] = [];
    const shared = new FallbackRpc(
      [
        { name: "a", rpc: { getFeeStats: () => Promise.reject(new Error("down")) } as SorobanRpc },
        { name: "b", rpc: { getFeeStats: async () => ({}) } as unknown as SorobanRpc },
      ],
      { onSwitch: (from, to, _e, by) => switches.push(`${from}->${to} by ${by}`) },
    );
    const upstream = failoverUpstream(
      async () => {
        await shared.getFeeStats();
        return [a, b];
      },
      { active: shared, timeoutMs: 20 },
    );
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
    expect(a.verify).not.toHaveBeenCalled();
    expect(switches).toEqual(["a->b by getFeeStats"]);
  });

  it("moves calls on along the endpoints one call finds failing", async () => {
    const a = endpoint("a", new Error("x"));
    const b = endpoint("b", "hang");
    const c = endpoint("c", valid);
    const { upstream, switches } = failover([a, b, c], { timeoutMs: 20 });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
    expect(switches).toEqual(["a->b by verify", "b->c by verify"]);
  });

  it("moves calls once for concurrent calls in one outage", async () => {
    const a = endpoint("a", "hang");
    const b = endpoint("b", valid);
    const { upstream, switches } = failover([a, b], { timeoutMs: 20 });
    await Promise.all([1, 2, 3].map(() => upstream.verify(payload, requirements)));
    expect(switches).toEqual(["a->b by verify"]);
  });

  it("reports nothing more for a call that began before another one moved calls", async () => {
    let fail!: (error: Error) => void;
    const late = () => new Promise<VerifyResponse>((_, reject) => (fail = reject));
    const a = endpoint("a", late, new Error("x"));
    const b = endpoint("b", new Error("y"), valid);
    const c = endpoint("c", valid);
    const { upstream, switches } = failover([a, b, c]);
    const first = upstream.verify(payload, requirements); // on a, waiting
    await vi.waitFor(() => expect(a.verify).toHaveBeenCalledTimes(1));
    // Another call finds a and b failing: calls move to c.
    await upstream.verify(payload, requirements);
    // The first call's a fails late: it reports nothing (calls already moved), and b answers it.
    fail(new Error("late"));
    await expect(first).resolves.toEqual(valid);
    expect(switches).toEqual(["a->b by verify", "b->c by verify"]);
  });

  it("forwards the payload and the requirements to the endpoint", async () => {
    const a = endpoint("a", valid);
    await failover([a]).upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledExactlyOnceWith(payload, requirements);
  });

  it("names every endpoint tried in onExhausted when all fail, and keeps the answer if it throws", async () => {
    const onExhausted = vi.fn(() => {
      throw new Error("logger down");
    });
    const error = new Error("x");
    const { upstream } = failover([endpoint("a", unexpected), endpoint("b", error)], {
      onExhausted,
    });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(unexpected);
    expect(onExhausted).toHaveBeenCalledExactlyOnceWith([
      { name: "a", failure: { answer: unexpected } },
      { name: "b", failure: { error } },
    ]);
  });

  it("returns the first failure when every endpoint fails", async () => {
    const thrown = failover([endpoint("a", "hang"), endpoint("b", unexpected)], { timeoutMs: 20 });
    await expect(thrown.upstream.verify(payload, requirements)).rejects.toBeInstanceOf(
      UpstreamTimeoutError,
    );
    const a = endpoint("a", unexpected);
    const answered = failover([a, endpoint("b", unexpected)]);
    const trace: VerifyTrace = {};
    await expect(answered.upstream.verify(payload, requirements, trace)).resolves.toEqual(
      unexpected,
    );
    expect(trace).toEqual({ rpc: "a" });
    expect(answered.switches).toEqual([]);
  });

  it("passes a rejection from the endpoint calls moved to", async () => {
    const a = endpoint("a", new Error("x"));
    const b = endpoint("b", invalid);
    const { upstream } = failover([a, b]);
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(invalid);
  });

  it("reads the endpoints once per call, before any endpoint's deadline starts", async () => {
    vi.useFakeTimers();
    try {
      const a = endpoint("a", valid);
      // A bid read that takes longer than one endpoint's timeoutMs.
      const endpoints = vi.fn(
        () => new Promise<UpstreamEndpoint[]>((resolve) => setTimeout(() => resolve([a]), 15)),
      );
      const shared = new FallbackRpc([{ name: "a", rpc: {} as SorobanRpc }]);
      const upstream = failoverUpstream(endpoints, { active: shared, timeoutMs: 10 });
      const answer = upstream.verify(payload, requirements);
      await vi.advanceTimersByTimeAsync(15);
      await expect(answer).resolves.toEqual(valid);
      expect(endpoints).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs an endpoint", async () => {
    const shared = new FallbackRpc([{ name: "a", rpc: {} as SorobanRpc }]);
    await expect(
      failoverUpstream(async () => [], { active: shared }).verify(payload, requirements),
    ).rejects.toThrow("at least one endpoint");
  });
});
