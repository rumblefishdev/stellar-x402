import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { failoverUpstream } from "../src/settlement/upstream-failover.js";
import { UpstreamTimeoutError, type UpstreamVerifier } from "../src/settlement/verify.js";

const payload = {} as PaymentPayload;
const requirements = {} as PaymentRequirements;
const valid: VerifyResponse = { isValid: true, payer: "GPAYER" };
const invalid: VerifyResponse = { isValid: false, invalidReason: "invalid_exact_stellar_payload" };
const unexpected: VerifyResponse = { isValid: false, invalidReason: "unexpected_verify_error" };

/** An endpoint whose `verify()` answers each call with the next behaviour, the last one after. */
function endpoint(name: string, ...behaviours: (VerifyResponse | Error | "hang")[]) {
  let call = 0;
  const verify = vi.fn<UpstreamVerifier["verify"]>(async () => {
    const behaviour = behaviours[Math.min(call++, behaviours.length - 1)]!;
    if (behaviour === "hang") return new Promise<never>(() => {});
    if (behaviour instanceof Error) throw behaviour;
    return behaviour;
  });
  return { name, verifier: { verify }, verify };
}

describe("failoverUpstream", () => {
  it("answers from the first endpoint while it works", async () => {
    const a = endpoint("a", valid);
    const b = endpoint("b", valid);
    const upstream = failoverUpstream([a, b]);
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
    expect(b.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["answers unexpected_verify_error", unexpected],
    ["throws", new Error("rpc down")],
  ] as const)("tries the next endpoint when one %s, and stays on it", async (_, failure) => {
    const a = endpoint("a", failure);
    const b = endpoint("b", valid);
    const onSwitch = vi.fn();
    const upstream = failoverUpstream([a, b], { onSwitch });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
    expect(onSwitch).toHaveBeenCalledWith("a", "b");
    await upstream.verify(payload, requirements);
    expect(a.verify).toHaveBeenCalledTimes(1);
    expect(b.verify).toHaveBeenCalledTimes(2);
  });

  it("tries the next endpoint when one takes longer than timeoutMs", async () => {
    const a = endpoint("a", "hang");
    const b = endpoint("b", valid);
    const upstream = failoverUpstream([a, b], { timeoutMs: 20 });
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid);
  });

  it("passes on a verdict without trying the next endpoint, a rejection included", async () => {
    const a = endpoint("a", invalid);
    const b = endpoint("b", valid);
    const upstream = failoverUpstream([a, b]);
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(invalid);
    expect(b.verify).not.toHaveBeenCalled();
  });

  it("wraps around from the active endpoint", async () => {
    const a = endpoint("a", unexpected, valid);
    const b = endpoint("b", valid, unexpected);
    const onSwitch = vi.fn();
    const upstream = failoverUpstream([a, b], { onSwitch });
    await upstream.verify(payload, requirements); // a fails, b answers
    await expect(upstream.verify(payload, requirements)).resolves.toEqual(valid); // b fails, a
    expect(onSwitch.mock.calls).toEqual([
      ["a", "b"],
      ["b", "a"],
    ]);
  });

  it("returns the first failure when every endpoint fails, and keeps the active one", async () => {
    const onSwitch = vi.fn();
    const thrown = failoverUpstream([endpoint("a", "hang"), endpoint("b", unexpected)], {
      timeoutMs: 20,
      onSwitch,
    });
    await expect(thrown.verify(payload, requirements)).rejects.toBeInstanceOf(UpstreamTimeoutError);

    const answered = failoverUpstream([endpoint("a", unexpected), endpoint("b", new Error("x"))]);
    await expect(answered.verify(payload, requirements)).resolves.toEqual(unexpected);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("needs an endpoint", () => {
    expect(() => failoverUpstream([])).toThrow("at least one endpoint");
  });
});
