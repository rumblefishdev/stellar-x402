import type { StellarNetwork } from "@stellar-x402/config";
import { byName, seriesDims } from "@stellar-x402/metrics-catalog";
import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import { describe, expect, test } from "vitest";
import {
  METRIC,
  NAMESPACE,
  type PutMetricDataInput,
  UNIT,
  type WatchTarget,
  balanceMetricData,
  runBalance,
} from "../src/watch/balance.js";
import { TARGETS_ENV, parseTargets } from "../src/watch/targets.js";

const TESTNET_FEE = "GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP";
const PUBNET_FEE = "GCW5TAO7CB6FDNXLMZJZHQKKKGDBEAXMOGGYO2MCI2WXMKNGFWLLG7VY";
const AT = new Date("2026-11-06T09:30:00Z");

const testnet: WatchTarget = {
  network: "stellar:testnet",
  feeAccount: TESTNET_FEE,
  rpcUrl: "https://soroban-testnet.stellar.org",
};
const pubnet: WatchTarget = {
  network: "stellar:pubnet",
  feeAccount: PUBNET_FEE,
  rpcUrl: "https://rpc.example.com/key-abc123",
};

/** An RPC holding `account` with `balance` stroops and no subentries (reserve 1 XLM). */
function rpcWith(account: string, balance: bigint): FakeRpc {
  const rpc = new FakeRpc({});
  rpc.sequences.set(account, 1n);
  rpc.balances.set(account, balance);
  return rpc;
}

function harness(rpcs: Record<string, Pick<FakeRpc, "getLedgerEntries">>) {
  const published: PutMetricDataInput[] = [];
  const logs: Record<string, unknown>[] = [];
  return {
    published,
    logs,
    deps: (targets: WatchTarget[]) => ({
      targets,
      rpcFor: (url: string) => {
        const rpc = rpcs[url];
        if (!rpc) throw new Error(`no fake for ${url}`);
        return rpc;
      },
      publish: async (input: PutMetricDataInput) => {
        published.push(input);
      },
      log: (line: Record<string, unknown>) => logs.push(line),
      at: AT,
      deadlineMs: 200,
    }),
  };
}

describe("the balance metric", () => {
  test("matches the catalog's spendable_stroops: namespace, unit, network-scoped", () => {
    const def = byName(METRIC);
    expect(def?.namespace).toBe(NAMESPACE);
    expect(def?.unit).toBe(UNIT);
    const data = balanceMetricData([{ network: "stellar:testnet", spendableStroops: 5n }], AT);
    const dims = Object.fromEntries(data.MetricData[0]!.Dimensions.map((d) => [d.Name, d.Value]));
    expect(seriesDims(METRIC, dims)).toEqual({ ok: true, namespace: NAMESPACE });
  });

  test("refuses a balance a double can't hold exactly", () => {
    expect(() =>
      balanceMetricData(
        [{ network: "stellar:testnet", spendableStroops: BigInt(Number.MAX_SAFE_INTEGER) + 1n }],
        AT,
      ),
    ).toThrow(/safe number/);
  });
});

describe("runBalance", () => {
  test("publishes the spendable balance, reserve taken off, stamped at the scheduled time", async () => {
    const h = harness({ [testnet.rpcUrl]: rpcWith(TESTNET_FEE, 250_000_000n) });
    await runBalance(h.deps([testnet]));
    expect(h.published).toEqual([
      {
        Namespace: "x402-watch",
        MetricData: [
          {
            MetricName: "spendable_stroops",
            Dimensions: [{ Name: "network", Value: "stellar:testnet" }],
            // 25 XLM less the 1 XLM base reserve of an account with no subentries.
            Value: 240_000_000,
            Unit: "None",
            Timestamp: AT,
          },
        ],
      },
    ]);
    expect(h.logs).toEqual([
      expect.objectContaining({ msg: "watch_balance", spendable_stroops: "240000000" }),
    ]);
  });

  test("publishes 0, not a negative, for an account below its reserve", async () => {
    const h = harness({ [testnet.rpcUrl]: rpcWith(TESTNET_FEE, 5_000_000n) });
    await runBalance(h.deps([testnet]));
    expect(h.published[0]?.MetricData[0]?.Value).toBe(0);
  });

  test("reads every network and publishes them in one call", async () => {
    const h = harness({
      [testnet.rpcUrl]: rpcWith(TESTNET_FEE, 1_010_000_000n),
      [pubnet.rpcUrl]: rpcWith(PUBNET_FEE, 60_000_000n),
    });
    await runBalance(h.deps([testnet, pubnet]));
    expect(h.published).toHaveLength(1);
    expect(
      h.published[0]!.MetricData.map((d) => [d.Dimensions[0]!.Value, d.Value] as const),
    ).toEqual([
      ["stellar:testnet", 1_000_000_000],
      ["stellar:pubnet", 50_000_000],
    ]);
  });

  test("publishes the networks it read, nothing for one that failed, then throws", async () => {
    const h = harness({
      [testnet.rpcUrl]: rpcWith(TESTNET_FEE, 1_010_000_000n),
      // No such account: checkFacilitatorBalance throws.
      [pubnet.rpcUrl]: new FakeRpc({}),
    });
    await expect(runBalance(h.deps([testnet, pubnet]))).rejects.toThrow(
      /balance not read on stellar:pubnet/,
    );
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.MetricData.map((d) => d.Dimensions[0]!.Value)).toEqual([
      "stellar:testnet",
    ]);
  });

  test("publishes nothing and throws when no network was read: never a 0 for a failed read", async () => {
    const h = harness({ [testnet.rpcUrl]: new FakeRpc({}) });
    await expect(runBalance(h.deps([testnet]))).rejects.toThrow(/Account not found/);
    expect(h.published).toEqual([]);
  });

  test("gives up on an RPC that doesn't answer by the deadline", async () => {
    const stalled = { getLedgerEntries: () => new Promise<never>(() => {}) };
    const h = harness({ [testnet.rpcUrl]: stalled as unknown as FakeRpc });
    await expect(runBalance(h.deps([testnet]))).rejects.toThrow(/no answer in 200 ms/);
    expect(h.published).toEqual([]);
  });

  test("keeps the RPC's URL, which can hold a provider's key, out of the log and the error", async () => {
    const leaky = {
      getLedgerEntries: async () => {
        throw new Error(`request to ${pubnet.rpcUrl} failed`);
      },
    };
    const h = harness({ [pubnet.rpcUrl]: leaky as unknown as FakeRpc });
    const run = runBalance(h.deps([pubnet]));
    await expect(run).rejects.toThrow(/rpc\(stellar:pubnet\)/);
    await expect(run).rejects.not.toThrow(/key-abc123/);
    expect(JSON.stringify(h.logs)).not.toContain("key-abc123");
  });

  test("masks the URL in the form a client writes it back, its path and its query too", async () => {
    const keyed: WatchTarget = {
      ...pubnet,
      rpcUrl: "HTTPS://RPC.Example.com:443/key-abc123?k=s3cr3t",
    };
    const leaky = {
      getLedgerEntries: async () => {
        throw new Error(
          "GET https://rpc.example.com/key-abc123?k=s3cr3t failed; path /key-abc123, query ?k=s3cr3t",
        );
      },
    };
    const h = harness({ [keyed.rpcUrl]: leaky as unknown as FakeRpc });
    await expect(runBalance(h.deps([keyed]))).rejects.toThrow(/rpc\(stellar:pubnet\)/);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toMatch(/key-abc123|s3cr3t/);
  });

  test("throws when the publish fails, so the run counts as an error", async () => {
    const h = harness({ [testnet.rpcUrl]: rpcWith(TESTNET_FEE, 1_010_000_000n) });
    const deps = {
      ...h.deps([testnet]),
      publish: async () => {
        throw new Error("AccessDenied");
      },
    };
    await expect(runBalance(deps)).rejects.toThrow(/AccessDenied/);
  });
});

describe("parseTargets", () => {
  const ok = JSON.stringify([testnet]);

  test("reads what the stack writes", () => {
    expect(parseTargets(ok)).toEqual([testnet]);
  });

  test.each<[string, string | undefined, RegExp]>([
    ["no variable", undefined, new RegExp(`${TARGETS_ENV} is not set`)],
    ["an empty list", "[]", /non-empty list/],
    [
      "an unknown network",
      JSON.stringify([{ ...testnet, network: "stellar:futurenet" }]),
      /network/,
    ],
    [
      "a secret key",
      JSON.stringify([{ ...testnet, feeAccount: `S${TESTNET_FEE.slice(1)}` }]),
      /feeAccount/,
    ],
    ["a plain-http RPC", JSON.stringify([{ ...testnet, rpcUrl: "http://rpc" }]), /https/],
  ])("refuses %s", (_, raw, message) => {
    expect(() => parseTargets(raw)).toThrow(message);
  });

  test("takes URLs by the config's rule, isHttpsUrl, so the two can't disagree", () => {
    const upper = { ...testnet, rpcUrl: "HTTPS://soroban-testnet.stellar.org" };
    expect(parseTargets(JSON.stringify([upper]))).toEqual([upper]);
    expect(() => parseTargets(JSON.stringify([{ ...testnet, rpcUrl: "https://x" }]))).toThrow(
      /https/,
    );
  });

  test("keeps the network type", () => {
    const network: StellarNetwork = parseTargets(ok)[0]!.network;
    expect(network).toBe("stellar:testnet");
  });
});
