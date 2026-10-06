import { Account, Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  MAX_CHANNELS_PER_TX,
  buildCreateChannelsTx,
  checkChannel,
  feeStatsInclusionFee,
} from "../src/index.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

describe("buildCreateChannelsTx", () => {
  it("creates each channel with the reserve and makes the facilitator its only signer", () => {
    const fac = Keypair.random();
    const chans = [Keypair.random(), Keypair.random()];
    const tx = buildCreateChannelsTx({
      facilitator: new Account(fac.publicKey(), "10"),
      channels: chans,
      networkPassphrase: PASSPHRASE,
    });
    expect(tx.source).toBe(fac.publicKey());
    expect(tx.operations).toHaveLength(4);
    const [create, options] = tx.operations;
    expect(create).toMatchObject({
      type: "createAccount",
      destination: chans[0]!.publicKey(),
      startingBalance: "1.5000000",
    });
    expect(options).toMatchObject({
      type: "setOptions",
      source: chans[0]!.publicKey(),
      masterWeight: 0,
      signer: { ed25519PublicKey: fac.publicKey(), weight: 1 },
    });
  });

  it("limits a transaction to 19 channels (20 signatures with the facilitator's)", () => {
    const fac = new Account(Keypair.random().publicKey(), "1");
    const many = Array.from({ length: MAX_CHANNELS_PER_TX + 1 }, () => Keypair.random());
    expect(() =>
      buildCreateChannelsTx({ facilitator: fac, channels: many, networkPassphrase: PASSPHRASE }),
    ).toThrow();
  });
});

function accountEntry(signers: { key: string; weight: number }[], thresholds = [0, 0, 0, 0]) {
  return {
    signers: () =>
      signers.map(
        (s) =>
          new xdr.Signer({
            key: xdr.SignerKey.signerKeyTypeEd25519(Keypair.fromPublicKey(s.key).rawPublicKey()),
            weight: s.weight,
          }),
      ),
    thresholds: () => Buffer.from(thresholds),
  } as unknown as xdr.AccountEntry;
}

describe("checkChannel", () => {
  const fac = Keypair.random().publicKey();
  const rpcWith = (entry?: xdr.AccountEntry) => ({
    getAccountEntry: async () => {
      if (!entry) throw new Error("Account not found: G");
      return entry;
    },
  });

  it("accepts a channel the facilitator can sign for", async () => {
    expect(await checkChannel(rpcWith(accountEntry([{ key: fac, weight: 1 }])), "G", fac)).toBe(
      undefined,
    );
  });

  it("reports missing accounts, missing signers and thresholds above the signer weight", async () => {
    expect(await checkChannel(rpcWith(), "G", fac)).toBe("missing");
    const other = Keypair.random().publicKey();
    expect(await checkChannel(rpcWith(accountEntry([{ key: other, weight: 1 }])), "G", fac)).toBe(
      "facilitator-not-signer",
    );
    expect(
      await checkChannel(rpcWith(accountEntry([{ key: fac, weight: 1 }], [1, 1, 2, 2])), "G", fac),
    ).toBe("thresholds-too-high");
  });

  it("requires the facilitator to be the only signer", async () => {
    const other = Keypair.random().publicKey();
    const withMaster = accountEntry([{ key: fac, weight: 1 }], [1, 0, 0, 0]);
    expect(await checkChannel(rpcWith(withMaster), "G", fac)).toBe("master-key-active");
    expect(await checkChannel(rpcWith(withMaster), "G", fac, { allowMasterKey: true })).toBe(
      undefined,
    );
    const shared = accountEntry([
      { key: fac, weight: 1 },
      { key: other, weight: 1 },
    ]);
    expect(await checkChannel(rpcWith(shared), "G", fac)).toBe("extra-signer");
    const zeroWeight = accountEntry([
      { key: fac, weight: 1 },
      { key: other, weight: 0 },
    ]);
    expect(await checkChannel(rpcWith(zeroWeight), "G", fac)).toBe(undefined);
  });

  it("throws RPC errors other than not-found instead of reporting missing", async () => {
    const flaky = { getAccountEntry: async () => Promise.reject(new Error("fetch failed")) };
    await expect(checkChannel(flaky, "G", fac)).rejects.toThrow("fetch failed");
  });
});

describe("feeStatsInclusionFee", () => {
  const stats = (p90: string, p50 = p90) =>
    ({ sorobanInclusionFee: { p90, p50 } }) as unknown as rpc.Api.GetFeeStatsResponse;

  it("bids the percentile clamped to the bounds and caches it", async () => {
    let t = 0;
    let calls = 0;
    let value = "200";
    const fee = feeStatsInclusionFee(
      {
        getFeeStats: async () => {
          calls++;
          return stats(value);
        },
      },
      { max: 1000, cacheMs: 100, now: () => t },
    );
    expect(await fee()).toBe(200);
    value = "5000";
    expect(await fee()).toBe(200); // cached
    t = 200;
    expect(await fee()).toBe(1000); // clamped to max
    expect(calls).toBe(2);
  });

  it("falls back to the last reading, then the floor, when the RPC fails", async () => {
    let fail = false;
    let t = 0;
    const fee = feeStatsInclusionFee(
      {
        getFeeStats: async () => {
          if (fail) throw new Error("down");
          return stats("300");
        },
      },
      { cacheMs: 0, now: () => t++ },
    );
    expect(await fee()).toBe(300);
    fail = true;
    expect(await fee()).toBe(300);
    const cold = feeStatsInclusionFee({ getFeeStats: async () => Promise.reject(new Error("x")) });
    expect(await cold()).toBe(100);
  });

  it("raises a low reading to the floor and reads the chosen percentile", async () => {
    const low = feeStatsInclusionFee({ getFeeStats: async () => stats("50") });
    expect(await low()).toBe(100);
    const p50 = feeStatsInclusionFee(
      { getFeeStats: async () => stats("900", "250") },
      { percentile: "p50" },
    );
    expect(await p50()).toBe(250);
  });

  it("shares one call between concurrent callers and caches a failure briefly", async () => {
    let calls = 0;
    let fail = false;
    let t = 0;
    const fee = feeStatsInclusionFee(
      {
        getFeeStats: async () => {
          calls++;
          if (fail) throw new Error("down");
          return stats("200");
        },
      },
      { cacheMs: 100, failureCacheMs: 50, now: () => t },
    );
    expect(await Promise.all(Array.from({ length: 50 }, () => fee()))).toEqual(Array(50).fill(200));
    expect(calls).toBe(1);

    t = 200;
    fail = true;
    expect(await Promise.all([fee(), fee(), fee()])).toEqual([200, 200, 200]);
    expect(calls).toBe(2);
    t = 220; // within failureCacheMs: no new call
    expect(await fee()).toBe(200);
    expect(calls).toBe(2);
    t = 260;
    await fee();
    expect(calls).toBe(3);
  });
});
