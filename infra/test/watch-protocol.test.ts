import { byName, seriesDims } from "@stellar-x402/metrics-catalog";
import { describe, expect, test } from "vitest";
import type { PutMetricDataInput } from "../src/watch/balance.js";
import { NAMESPACE } from "../src/watch/metric.js";
import {
  CURRENT,
  type ProtocolTarget,
  SUPPORTED,
  protocolMetricData,
  readProtocol,
  runProtocol,
} from "../src/watch/protocol.js";
import { PROTOCOL_ENV, parseProtocolTargets } from "../src/watch/targets.js";

const AT = new Date("2026-11-06T11:30:00Z");
const testnet: ProtocolTarget = {
  network: "stellar:testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
};
const pubnet: ProtocolTarget = {
  network: "stellar:pubnet",
  horizonUrl: "https://horizon.stellar.org",
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Horizon's root as it answered on 2026-11-06. */
const roots: Record<string, unknown> = {
  [testnet.horizonUrl]: { current_protocol_version: 30, core_supported_protocol_version: 30 },
  [pubnet.horizonUrl]: { current_protocol_version: 29, core_supported_protocol_version: 30 },
};
const horizon: Fetch = async (url) => json(200, roots[url]);

function harness(fetch: Fetch) {
  const published: PutMetricDataInput[] = [];
  const logs: Record<string, unknown>[] = [];
  return {
    published,
    logs,
    deps: (targets: ProtocolTarget[]) => ({
      targets,
      fetch,
      publish: async (input: PutMetricDataInput) => {
        published.push(input);
      },
      log: (line: Record<string, unknown>) => logs.push(line),
      at: AT,
      deadlineMs: 200,
    }),
  };
}

describe("the protocol metrics", () => {
  test("match the catalog: x402-watch, unit None, network-scoped", () => {
    for (const name of [CURRENT, SUPPORTED]) {
      expect(byName(name)?.unit).toBe("None");
      expect(seriesDims(name, { network: "stellar:pubnet" })).toEqual({
        ok: true,
        namespace: NAMESPACE,
      });
    }
  });

  test("two points per network, stamped at the scheduled time", () => {
    expect(
      protocolMetricData([{ network: "stellar:pubnet", current: 29, supported: 30 }], AT),
    ).toEqual({
      Namespace: "x402-watch",
      MetricData: [
        {
          MetricName: "protocol_version",
          Dimensions: [{ Name: "network", Value: "stellar:pubnet" }],
          Value: 29,
          Unit: "None",
          Timestamp: AT,
        },
        {
          MetricName: "protocol_supported_version",
          Dimensions: [{ Name: "network", Value: "stellar:pubnet" }],
          Value: 30,
          Unit: "None",
          Timestamp: AT,
        },
      ],
    });
  });
});

describe("readProtocol", () => {
  test("reads the current and the supported version from Horizon's root", async () => {
    expect(await readProtocol(pubnet, horizon)).toEqual({
      network: "stellar:pubnet",
      current: 29,
      supported: 30,
    });
  });

  test.each<[string, Fetch, RegExp]>([
    ["a 503", async () => json(503, {}), /status 503/],
    ["no versions", async () => json(200, { horizon_version: "x" }), /no protocol versions/],
    [
      "a version as a string",
      async () =>
        json(200, { current_protocol_version: "30", core_supported_protocol_version: 30 }),
      /no protocol versions/,
    ],
    ["a body that is null", async () => json(200, null), /no protocol versions/],
  ])("refuses %s", async (_, fetch, message) => {
    await expect(readProtocol(testnet, fetch)).rejects.toThrow(message);
  });
});

describe("runProtocol", () => {
  test("reads every network, served or not, and publishes them in one call", async () => {
    const h = harness(horizon);
    await runProtocol(h.deps([testnet, pubnet]));
    expect(h.published).toHaveLength(1);
    expect(
      h.published[0]!.MetricData.map((d) => [d.MetricName, d.Dimensions[0]!.Value, d.Value]),
    ).toEqual([
      ["protocol_version", "stellar:testnet", 30],
      ["protocol_supported_version", "stellar:testnet", 30],
      ["protocol_version", "stellar:pubnet", 29],
      ["protocol_supported_version", "stellar:pubnet", 30],
    ]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ msg: "watch_protocol", network: "stellar:pubnet", supported: 30 }),
    );
  });

  test("publishes the networks it read, nothing for one that failed, then throws", async () => {
    const h = harness(async (url) =>
      url === pubnet.horizonUrl ? json(502, "bad gateway") : horizon(url, {}),
    );
    await expect(runProtocol(h.deps([testnet, pubnet]))).rejects.toThrow(
      /protocol not read on stellar:pubnet \(Error: status 502\)/,
    );
    expect(h.published[0]!.MetricData.map((d) => d.Dimensions[0]!.Value)).toEqual([
      "stellar:testnet",
      "stellar:testnet",
    ]);
  });

  test("gives up on a Horizon that doesn't answer by the deadline", async () => {
    const h = harness(
      (_, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    await expect(runProtocol(h.deps([testnet]))).rejects.toThrow(/protocol not read/);
    expect(h.published).toEqual([]);
  });

  test("keeps the URL out of the log and the error", async () => {
    const keyed = { ...pubnet, horizonUrl: "https://horizon.example.com/key-abc123" };
    const h = harness(async () => {
      throw new TypeError(`fetch failed: ${keyed.horizonUrl}`);
    });
    const run = runProtocol(h.deps([keyed]));
    await expect(run).rejects.toThrow(/horizon\(stellar:pubnet\)/);
    await expect(run).rejects.not.toThrow(/key-abc123/);
    expect(JSON.stringify(h.logs)).not.toContain("key-abc123");
  });
});

describe("parseProtocolTargets", () => {
  test("reads what the stack writes, and none when it is unset", () => {
    expect(parseProtocolTargets(JSON.stringify([testnet, pubnet]))).toEqual([testnet, pubnet]);
    expect(parseProtocolTargets(undefined)).toEqual([]);
    expect(parseProtocolTargets("[]")).toEqual([]);
  });

  test.each<[string, string, RegExp]>([
    ["not a list", "{}", new RegExp(`${PROTOCOL_ENV} must be a list`)],
    [
      "an unknown network",
      JSON.stringify([{ ...testnet, network: "stellar:futurenet" }]),
      /network/,
    ],
    [
      "a plain-http Horizon",
      JSON.stringify([{ ...testnet, horizonUrl: "http://h.example.com" }]),
      /https/,
    ],
  ])("refuses %s", (_, raw, message) => {
    expect(() => parseProtocolTargets(raw)).toThrow(message);
  });
});
