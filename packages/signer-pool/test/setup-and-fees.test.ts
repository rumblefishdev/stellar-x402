import { Account, Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  MAX_CHANNELS_PER_TX,
  buildCreateChannelsTx,
  checkChannel,
  feeStatsInclusionFee,
} from "../src/index.js";
import { ledgerEntries } from "./fake-rpc.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

describe("buildCreateChannelsTx", () => {
  it("creates each channel with the reserve and makes the facilitator its only signer", () => {
    const fac = Keypair.random();
    const chans = [Keypair.random(), Keypair.random()];
    const tx = buildCreateChannelsTx({
      funder: new Account(fac.publicKey(), "10"),
      signer: fac.publicKey(),
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

  it("lets another account fund the channels, so the facilitator key signs nothing", () => {
    const funder = Keypair.random();
    const fac = Keypair.random();
    const chans = [Keypair.random()];
    const tx = buildCreateChannelsTx({
      funder: new Account(funder.publicKey(), "10"),
      signer: fac.publicKey(),
      channels: chans,
      networkPassphrase: PASSPHRASE,
    });
    expect(tx.source).toBe(funder.publicKey());
    expect(tx.operations[0]).toMatchObject({
      type: "createAccount",
      destination: chans[0]!.publicKey(),
    });
    expect(tx.operations[1]).toMatchObject({
      type: "setOptions",
      source: chans[0]!.publicKey(),
      masterWeight: 0,
      signer: { ed25519PublicKey: fac.publicKey(), weight: 1 },
    });
  });

  it("limits a transaction to 19 channels (20 signatures with the funder's)", () => {
    const funder = Keypair.random().publicKey();
    const many = Array.from({ length: MAX_CHANNELS_PER_TX + 1 }, () => Keypair.random());
    expect(() =>
      buildCreateChannelsTx({
        funder: new Account(funder, "1"),
        signer: funder,
        channels: many,
        networkPassphrase: PASSPHRASE,
      }),
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
  const ch = Keypair.random().publicKey();
  const rpcWith = (entry?: xdr.AccountEntry) => ({
    getLedgerEntries: async () => ledgerEntries(entry),
  });

  it("accepts a channel the facilitator can sign for", async () => {
    expect(await checkChannel(rpcWith(accountEntry([{ key: fac, weight: 1 }])), ch, fac)).toBe(
      undefined,
    );
  });

  it("reports missing accounts, missing signers and thresholds above the signer weight", async () => {
    expect(await checkChannel(rpcWith(), ch, fac)).toBe("missing");
    const other = Keypair.random().publicKey();
    expect(await checkChannel(rpcWith(accountEntry([{ key: other, weight: 1 }])), ch, fac)).toBe(
      "facilitator-not-signer",
    );
    expect(
      await checkChannel(rpcWith(accountEntry([{ key: fac, weight: 1 }], [1, 1, 2, 2])), ch, fac),
    ).toBe("thresholds-too-high");
  });

  it("requires the facilitator to be the only signer", async () => {
    const other = Keypair.random().publicKey();
    const withMaster = accountEntry([{ key: fac, weight: 1 }], [1, 0, 0, 0]);
    expect(await checkChannel(rpcWith(withMaster), ch, fac)).toBe("master-key-active");
    const shared = accountEntry([
      { key: fac, weight: 1 },
      { key: other, weight: 1 },
    ]);
    expect(await checkChannel(rpcWith(shared), ch, fac)).toBe("extra-signer");
    const zeroWeight = accountEntry([
      { key: fac, weight: 1 },
      { key: other, weight: 0 },
    ]);
    expect(await checkChannel(rpcWith(zeroWeight), ch, fac)).toBe(undefined);
  });

  it("throws RPC errors other than not-found instead of reporting missing", async () => {
    const flaky = { getLedgerEntries: async () => Promise.reject(new Error("fetch failed")) };
    await expect(checkChannel(flaky, ch, fac)).rejects.toThrow("fetch failed");
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

  it("treats a percentile that isn't a whole number as a failed read", async () => {
    let p90: unknown = "300";
    let t = 0;
    const fee = feeStatsInclusionFee(
      {
        getFeeStats: async () =>
          ({ sorobanInclusionFee: { p90 } }) as unknown as rpc.Api.GetFeeStatsResponse,
      },
      { cacheMs: 0, failureCacheMs: 0, now: () => t++ },
    );
    expect(await fee()).toBe(300);
    // `Number` reads the blank ones and null as 0, which would cache the floor as a good reading.
    for (const bad of ["n/a", "", " ", null, 300, "1e3", "-5", "12.5"]) {
      p90 = bad;
      expect(await fee(), JSON.stringify(bad)).toBe(300);
    }
    p90 = "400";
    expect(await fee()).toBe(400);
    const missing = feeStatsInclusionFee({
      getFeeStats: async () =>
        ({ sorobanInclusionFee: {} }) as unknown as rpc.Api.GetFeeStatsResponse,
    });
    expect(await missing()).toBe(100);
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
