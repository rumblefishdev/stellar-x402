import { Keypair } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { atCurrentBid, feeSettings } from "../src/settlement/fees.js";

const env = {
  FACILITATOR_SECRET: Keypair.random().secret(),
  DATABASE_URL: "postgres://db.internal/x402",
  CLIENT_IP: "socket",
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

describe("atCurrentBid", () => {
  it("builds for twice the current bid, again only when the bid changes", async () => {
    let bid = 250;
    const build = vi.fn((inclusionFeeStroops: number) => ({ inclusionFeeStroops }));
    const atBid = atCurrentBid(async () => bid, build);

    // The fee bump pays the bid twice (settlementInclusionFee).
    await expect(atBid()).resolves.toEqual({ inclusionFeeStroops: 500 });
    const first = await atBid();
    expect(build).toHaveBeenCalledOnce();

    bid = 400;
    await expect(atBid()).resolves.toEqual({ inclusionFeeStroops: 800 });
    expect(build.mock.calls).toEqual([[500], [800]]);
    expect(await atBid()).not.toBe(first);
  });

  it("reads the bid on every call", async () => {
    const inclusionFee = vi.fn(async () => 100);
    const atBid = atCurrentBid(inclusionFee, () => "built");
    await atBid();
    await atBid();
    expect(inclusionFee).toHaveBeenCalledTimes(2);
  });
});
