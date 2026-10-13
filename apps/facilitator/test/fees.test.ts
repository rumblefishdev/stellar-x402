import { Keypair } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { feeSettings, upstreamAtCurrentBid } from "../src/settlement/fees.js";
import type { UpstreamVerifier } from "../src/settlement/verify.js";

const env = {
  FACILITATOR_SECRET: Keypair.random().secret(),
  CHANNELS: Keypair.random().publicKey(),
};

/** An RPC whose fee stats report a p90 inclusion fee of `p90`. */
function feeStatsRpc(p90: number) {
  const getFeeStats = vi.fn(
    async () =>
      ({ sorobanInclusionFee: { p90: String(p90) } }) as unknown as Awaited<
        ReturnType<SorobanRpc["getFeeStats"]>
      >,
  );
  return { getFeeStats };
}

describe("feeSettings (AD-10)", () => {
  it("feeds one ceiling and one fixed inclusion bid to upstream and the pool", async () => {
    const config = parseConfig({
      ...env,
      MAX_FEE_STROOPS: "300000",
      INCLUSION_FEE_STROOPS: "500",
      FEE_ESCALATION_FACTOR: "2",
      FEE_ESCALATION_MAX_STROOPS: "2000",
    });
    const rpc = feeStatsRpc(250);
    const fees = feeSettings(config.fees, rpc);
    expect(fees.maxFeeStroops).toBe(300_000);
    await expect(fees.inclusionFee()).resolves.toBe(500);
    expect(fees.pool).toEqual({
      maxFeeStroops: 300_000,
      inclusionFee: fees.inclusionFee,
      feeEscalation: { factor: 2, max: 2000 },
    });
    expect(rpc.getFeeStats).not.toHaveBeenCalled();
  });

  it("shares one fee-stats provider between upstream and the pool without a fixed bid", async () => {
    const rpc = feeStatsRpc(250);
    const fees = feeSettings(parseConfig(env).fees, rpc);
    expect(fees.maxFeeStroops).toBe(250_000);
    expect(fees.pool.inclusionFee).toBe(fees.inclusionFee);
    await expect(fees.inclusionFee()).resolves.toBe(250);
    await expect(fees.inclusionFee()).resolves.toBe(250);
    // One cached reading serves both components.
    expect(rpc.getFeeStats).toHaveBeenCalledTimes(1);
  });

  it("refuses fee settings a number can't hold", () => {
    const tooLarge = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    for (const name of ["MAX_FEE_STROOPS", "INCLUSION_FEE_STROOPS"]) {
      expect(() => parseConfig({ ...env, [name]: tooLarge }), name).toThrow(ConfigError);
    }
    expect(() =>
      parseConfig({ ...env, MAX_FEE_STROOPS: String(Number.MAX_SAFE_INTEGER) }),
    ).not.toThrow();
  });
});

describe("upstreamAtCurrentBid", () => {
  const payload = {} as PaymentPayload;
  const requirements = {} as PaymentRequirements;

  it("verifies with a scheme built for the current bid, rebuilt only when the bid changes", async () => {
    let bid = 250;
    const built: number[] = [];
    const build = vi.fn((inclusionFeeStroops: number): UpstreamVerifier => {
      built.push(inclusionFeeStroops);
      return { verify: async () => ({ isValid: true, payer: `at ${inclusionFeeStroops}` }) };
    });
    const upstream = upstreamAtCurrentBid(async () => bid, build);

    await expect(upstream.verify(payload, requirements)).resolves.toEqual({
      isValid: true,
      payer: "at 250",
    });
    await upstream.verify(payload, requirements);
    expect(built).toEqual([250]);

    bid = 400;
    await expect(upstream.verify(payload, requirements)).resolves.toMatchObject({
      payer: "at 400",
    });
    expect(built).toEqual([250, 400]);
  });

  it("passes the request to the scheme as is", async () => {
    const verify = vi.fn<UpstreamVerifier["verify"]>(async () => ({ isValid: false }));
    const upstream = upstreamAtCurrentBid(
      async () => 100,
      () => ({ verify }),
    );
    await upstream.verify(payload, requirements);
    expect(verify).toHaveBeenCalledWith(payload, requirements);
  });
});
