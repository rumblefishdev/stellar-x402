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
    expect(onSwitch).toHaveBeenCalledWith("a", "b", expect.anything());
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
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("a", "b", expect.anything());
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
    expect(onSwitch.mock.calls.map(([from, to]) => [from, to])).toEqual([
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
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("a", "b", expect.anything());
    // b stays active.
    await upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledTimes(2);
    expect(b.verify).toHaveBeenCalledTimes(2);
  });

  it("doesn't switch back after A → B → A for a call that began on A (switch counter)", async () => {
    let answerLate!: (answer: VerifyResponse) => void;
    const late = () => new Promise<VerifyResponse>((resolve) => (answerLate = resolve));
    const a = endpoint("a", unexpected, unexpected, valid);
    const b = endpoint("b", late, valid, unexpected);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { onSwitch });
    const x = upstream.verify(payload, requirements); // a fails, then waits on b
    await vi.waitFor(() => expect(b.verify).toHaveBeenCalledTimes(1));
    await upstream.verify(payload, requirements); // a fails, b answers: a → b
    await upstream.verify(payload, requirements); // b fails, a answers: b → a
    answerLate(valid);
    await expect(x).resolves.toEqual(valid);
    // An index guard (`current === active`, both 0 again) would have switched to b a third time.
    expect(onSwitch.mock.calls.map(([from, to]) => [from, to])).toEqual([
      ["a", "b"],
      ["b", "a"],
    ]);
  });

  it("switches once for concurrent calls in one outage", async () => {
    const a = endpoint("a", "hang");
    const b = endpoint("b", valid);
    const onSwitch = vi.fn();
    const upstream = failover([a, b], { timeoutMs: 20, onSwitch });
    await Promise.all([1, 2, 3].map(() => upstream.verify(payload, requirements)));
    expect(onSwitch.mock.calls.map(([from, to]) => [from, to])).toEqual([["a", "b"]]);
  });

  it("passes the active endpoint's failure to onSwitch", async () => {
    const onSwitch = vi.fn();
    const error = new Error("rpc down");
    await failover([endpoint("a", error), endpoint("b", valid)], { onSwitch }).verify(
      payload,
      requirements,
    );
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("a", "b", { error });
  });

  it("keeps the answer when onSwitch throws", async () => {
    const a = endpoint("a", unexpected);
    const b = endpoint("b", valid);
    const upstream = failover([a, b], {
      onSwitch: () => {
        throw new Error("logger down");
      },
    });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
    await upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledTimes(1);
  });

  it("forwards the payload and the requirements to the endpoint", async () => {
    const a = endpoint("a", valid);
    await failover([a]).verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledExactlyOnceWith(payload, requirements);
  });

  it("names every endpoint tried in onExhausted when all fail", async () => {
    const onExhausted = vi.fn();
    const error = new Error("x");
    const upstream = failover([endpoint("a", unexpected), endpoint("b", error)], { onExhausted });
    await upstream.verify(payload, requirements);
    expect(onExhausted).toHaveBeenCalledExactlyOnceWith([
      { name: "a", failure: { answer: unexpected } },
      { name: "b", failure: { error } },
    ]);
  });

  describe("returning to the first endpoint", () => {
    /** A failover on a, b (and c) whose probe reads `ledgers[i]`, or throws it. */
    function probed(list: UpstreamEndpoint[], ledgers: (number | Error)[]) {
      let time = 0;
      const latestLedger = vi.fn(async (i: number) => {
        const ledger = ledgers[i]!;
        if (ledger instanceof Error) throw ledger;
        return ledger;
      });
      const events = { onSwitch: vi.fn(), onFailback: vi.fn(), onProbeFailed: vi.fn() };
      const upstream = failover(list, {
        ...events,
        latestLedger,
        probeIntervalMs: 60_000,
        maxLagLedgers: 2,
        now: () => time,
      });
      return { upstream, latestLedger, ...events, at: (t: number) => (time = t) };
    }

    it("returns only after a probe finds it healthy, never from a client's payload", async () => {
      const a = endpoint("a", unexpected, valid);
      const b = endpoint("b", valid);
      const p = probed([a, b], [100, 101]);
      await p.upstream.verify(payload, requirements); // a fails, b answers
      p.at(59_999);
      await p.upstream.verify(payload, requirements);
      expect(p.latestLedger).not.toHaveBeenCalled();

      p.at(60_000);
      const trace: VerifyTrace = {};
      await p.upstream.verify(payload, requirements, trace);
      // The probe runs beside the call, which is answered by the active endpoint.
      expect(trace).toEqual({ rpc: "b" });
      expect(a.verify).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(p.onFailback).toHaveBeenCalledExactlyOnceWith("b", "a", 1));
      expect(p.latestLedger.mock.calls).toEqual([[0], [1]]);

      await p.upstream.verify(payload, requirements, trace);
      expect(trace).toEqual({ rpc: "a" });
      expect(b.verify).toHaveBeenCalledTimes(3);
    });

    it("stays off a first endpoint whose probe fails, whatever payloads it would reject", async () => {
      // Upstream rejects a wrong amount before any RPC call, so a dead RPC would answer it.
      const wrongAmount: VerifyResponse = {
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_wrong_amount",
      };
      const a = endpoint("a", unexpected, wrongAmount);
      const b = endpoint("b", valid);
      const down = new Error("ECONNREFUSED");
      const p = probed([a, b], [down, 100]);
      await p.upstream.verify(payload, requirements);
      p.at(60_000);
      await p.upstream.verify(payload, requirements);
      await vi.waitFor(() =>
        expect(p.onProbeFailed).toHaveBeenCalledExactlyOnceWith("a", { error: down }),
      );
      // The next probe is due a full interval after this one.
      p.at(119_999);
      await p.upstream.verify(payload, requirements);
      expect(p.latestLedger).toHaveBeenCalledTimes(2);
      expect(a.verify).toHaveBeenCalledTimes(1);
      expect(p.onFailback).not.toHaveBeenCalled();
    });

    it("stays off a first endpoint that trails the active one by more than maxLagLedgers", async () => {
      const a = endpoint("a", unexpected, valid);
      const b = endpoint("b", valid);
      const p = probed([a, b], [97, 100]);
      await p.upstream.verify(payload, requirements);
      p.at(60_000);
      await p.upstream.verify(payload, requirements);
      await vi.waitFor(() =>
        expect(p.onProbeFailed).toHaveBeenCalledExactlyOnceWith("a", { lagLedgers: 3 }),
      );
      expect(p.onFailback).not.toHaveBeenCalled();
    });

    it("with three endpoints, never retries a known-bad fallback, and a fallback switch keeps the probe's time", async () => {
      const a = endpoint("a", unexpected);
      const b = endpoint("b", valid, unexpected);
      const c = endpoint("c", valid);
      const p = probed([a, b, c], [new Error("down"), 100, 100]);
      await p.upstream.verify(payload, requirements); // a fails, b answers: a → b
      p.at(50_000);
      await p.upstream.verify(payload, requirements); // b fails, c answers: b → c
      expect(p.onSwitch.mock.calls.map(([from, to]) => [from, to])).toEqual([
        ["a", "b"],
        ["b", "c"],
      ]);
      // The call on b went on to c, not back to a.
      expect(a.verify).toHaveBeenCalledTimes(1);
      // Due 60 s after calls left a, not 60 s after b → c.
      p.at(60_000);
      await p.upstream.verify(payload, requirements);
      expect(p.latestLedger.mock.calls).toEqual([[0], [2]]);
      expect(c.verify).toHaveBeenCalledTimes(2);
      expect(a.verify).toHaveBeenCalledTimes(1);
    });

    it("drops a probe's answer when calls switched while it ran", async () => {
      let answerProbe!: (ledger: number) => void;
      const a = endpoint("a", unexpected);
      const b = endpoint("b", valid, unexpected);
      const c = endpoint("c", valid);
      let time = 0;
      const latestLedger = vi.fn((i: number) =>
        i === 0 ? new Promise<number>((resolve) => (answerProbe = resolve)) : Promise.resolve(100),
      );
      const onFailback = vi.fn();
      const upstream = failover([a, b, c], { latestLedger, onFailback, now: () => time });
      await upstream.verify(payload, requirements); // a → b
      time = 60_000;
      await upstream.verify(payload, requirements); // starts the probe; b fails, c answers: b → c
      answerProbe(100);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onFailback).not.toHaveBeenCalled();
      const trace: VerifyTrace = {};
      await upstream.verify(payload, requirements, trace);
      expect(trace).toEqual({ rpc: "c" });
    });

    it("runs one probe at a time", async () => {
      let answerProbe!: (ledger: number) => void;
      const a = endpoint("a", unexpected, valid);
      const b = endpoint("b", valid);
      let time = 0;
      const latestLedger = vi.fn((i: number) =>
        i === 0 ? new Promise<number>((resolve) => (answerProbe = resolve)) : Promise.resolve(100),
      );
      const onFailback = vi.fn();
      const upstream = failover([a, b], { latestLedger, onFailback, now: () => time });
      await upstream.verify(payload, requirements);
      time = 60_000;
      await upstream.verify(payload, requirements);
      time = 200_000;
      await upstream.verify(payload, requirements);
      expect(latestLedger).toHaveBeenCalledTimes(2);
      answerProbe(100);
      await vi.waitFor(() => expect(onFailback).toHaveBeenCalledOnce());
    });
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
