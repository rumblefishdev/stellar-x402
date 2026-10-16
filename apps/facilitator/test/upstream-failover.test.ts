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

/** {@link failoverUpstream} over a fixed list of endpoints. */
function failover(endpoints: readonly UpstreamEndpoint[], opts?: UpstreamFailoverOptions) {
  return failoverUpstream(async () => endpoints, opts);
}

describe("failoverUpstream", () => {
  it("answers from the first endpoint while it works, and names it in the trace", async () => {
    const a = endpoint("a", valid);
    const b = endpoint("b", valid);
    const upstream = failover([a, b]);
    const trace: VerifyTrace = {};
    await expect(upstream.verify(payload, requirements, trace)).resolves.toEqual(valid);
    expect(trace).toEqual({ rpc: "a" });
    expect(b.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["answers unexpected_verify_error", unexpected],
    ["throws", new Error("rpc down")],
  ] as const)("tries the next endpoint when one %s, and stays on it", async (_, failure) => {
    const a = endpoint("a", failure);
    const b = endpoint("b", valid);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { onSwitch });
    const trace: VerifyTrace = {};
    await expect(upstream.verify(payload, requirements, trace)).resolves.toEqual(valid);
    expect(trace).toEqual({ rpc: "b" });
    expect(onSwitch).toHaveBeenCalledWith("a", "b");
    await upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledTimes(1);
    expect(b.verify).toHaveBeenCalledTimes(2);
  });

  it("tries the next endpoint when one takes longer than timeoutMs", async () => {
    const a = endpoint("a", "hang");
    const b = endpoint("b", valid);
    const upstream = failover([a, b], { timeoutMs: 20 });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
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
    const upstream = failover([a, b]);
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(rejection);
    expect(b.verify).not.toHaveBeenCalled();
  });

  it("makes the endpoint that rejected active", async () => {
    const a = endpoint("a", unexpected);
    const b = endpoint("b", invalid, valid);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { onSwitch });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(invalid);
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("a", "b");
    // The next call starts at b.
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
    expect(a.verify).toHaveBeenCalledTimes(1);
    expect(b.verify).toHaveBeenCalledTimes(2);
  });

  it("wraps around from the active endpoint", async () => {
    const a = endpoint("a", unexpected, valid);
    const b = endpoint("b", valid, unexpected);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { onSwitch });
    await upstream.verify(payload, requirements); // a fails, b answers
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid); // b fails, a
    expect(onSwitch.mock.calls).toEqual([
      ["a", "b"],
      ["b", "a"],
    ]);
  });

  it("doesn't switch back for a call that began before another one switched", async () => {
    let answerLate!: (answer: VerifyResponse) => void;
    const late = () => new Promise<VerifyResponse>((resolve) => (answerLate = resolve));
    const a = endpoint("a", late, unexpected);
    const b = endpoint("b", valid);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { onSwitch });
    const first = upstream.verify(payload, requirements); // on a, waiting
    await vi.waitFor(() => expect(a.verify).toHaveBeenCalledTimes(1));
    await upstream.verify(payload, requirements); // a fails, b answers: switch to b
    answerLate(valid);
    await expect(first).resolves.toEqual(valid);
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("a", "b");
    // b stays active.
    await upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledTimes(2);
    expect(b.verify).toHaveBeenCalledTimes(2);
  });

  it("tries the first endpoint first again after primaryRetryMs, once per interval", async () => {
    let time = 0;
    const a = endpoint("a", unexpected, unexpected, valid);
    const b = endpoint("b", valid);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { onSwitch, primaryRetryMs: 60_000, now: () => time });
    await upstream.verify(payload, requirements); // a fails, b answers
    time = 59_999;
    await upstream.verify(payload, requirements); // still on b
    expect(a.verify).toHaveBeenCalledTimes(1);

    time = 60_000;
    const trace: VerifyTrace = {};
    await upstream.verify(payload, requirements, trace); // a fails again, b answers
    expect(trace).toEqual({ rpc: "b" });
    expect(a.verify).toHaveBeenCalledTimes(2);
    expect(onSwitch).toHaveBeenCalledOnce(); // no new switch: b was already active
    time = 119_999;
    await upstream.verify(payload, requirements); // the interval restarted at the retry
    expect(a.verify).toHaveBeenCalledTimes(2);

    time = 120_000;
    await upstream.verify(payload, requirements); // a answers: back on a
    expect(onSwitch.mock.calls).toEqual([
      ["a", "b"],
      ["b", "a"],
    ]);
    await upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledTimes(4);
    expect(b.verify).toHaveBeenCalledTimes(4);
  });

  it("reads the endpoints once per call, before any endpoint's deadline starts", async () => {
    vi.useFakeTimers();
    try {
      const a = endpoint("a", valid);
      // A bid read that takes longer than one endpoint's timeoutMs.
      const endpoints = vi.fn(
        () => new Promise<UpstreamEndpoint[]>((resolve) => setTimeout(() => resolve([a]), 15)),
      );
      const upstream = failoverUpstream(endpoints, { timeoutMs: 10 });
      const answer = upstream.verify(payload, requirements);
      await vi.advanceTimersByTimeAsync(15);
      await expect(answer).resolves.toEqual(valid);
      expect(endpoints).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the first failure when every endpoint fails, and keeps the active one", async () => {
    const onSwitch = vi.fn();
    const thrown = failover([endpoint("a", "hang"), endpoint("b", unexpected)], {
      timeoutMs: 20,
      onSwitch,
    });
    await expect(thrown.verify(payload, requirements)).rejects.toBeInstanceOf(UpstreamTimeoutError);

    const a = endpoint("a", unexpected, valid);
    const b = endpoint("b", new Error("x"));
    const answered = failover([a, b], { onSwitch });
    const trace: VerifyTrace = {};
    await expect(answered.verify(payload, requirements, trace)).resolves.toEqual(unexpected);
    expect(trace).toEqual({ rpc: "a" });
    expect(onSwitch).not.toHaveBeenCalled();
    // The next call starts from the active endpoint, still the first.
    await expect(answered.verify(payload, requirements)).resolves.toEqual(valid);
    expect(a.verify).toHaveBeenCalledTimes(2);
    expect(b.verify).toHaveBeenCalledTimes(1);
  });

  it("needs an endpoint", async () => {
    await expect(failover([]).verify(payload, requirements)).rejects.toThrow(
      "at least one endpoint",
    );
  });
});
