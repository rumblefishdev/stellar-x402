import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import { describe, expect, test } from "vitest";
import type { PutMetricDataInput } from "../src/watch/balance.js";
import { createHandler, scheduledAt, stellarRpc } from "../src/watch/handler.js";

const FEE = "GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP";
const RPC = "https://soroban-testnet.stellar.org";
const env = {
  WATCH_TARGETS: JSON.stringify([{ network: "stellar:testnet", feeAccount: FEE, rpcUrl: RPC }]),
};
const NOW = new Date("2026-11-06T09:42:17Z");

describe("scheduledAt", () => {
  test.each<[string, unknown, string]>([
    ["the scheduled time", { scheduledTime: "2026-11-06T09:40:00Z" }, "2026-11-06T09:40:00.000Z"],
    ["now for a run by hand", {}, NOW.toISOString()],
    ["now for no event", undefined, NOW.toISOString()],
    ["now for a time that doesn't parse", { scheduledTime: "soon" }, NOW.toISOString()],
  ])("takes %s", (_, event, at) => {
    expect(scheduledAt(event as never, () => NOW).toISOString()).toBe(at);
  });
});

describe("createHandler", () => {
  function run(event: unknown) {
    const rpc = new FakeRpc({ [FEE]: 1n });
    rpc.balances.set(FEE, 1_010_000_000n);
    const asked: string[] = [];
    const published: PutMetricDataInput[] = [];
    const handler = createHandler({
      env,
      rpcFor: (url) => {
        asked.push(url);
        return rpc;
      },
      publish: async (input) => {
        published.push(input);
      },
      log: () => {},
      now: () => NOW,
    });
    return handler(event as never).then(() => ({ asked, published }));
  }

  test("stamps the point with the schedule's time, not when the run happens", async () => {
    const { published } = await run({ scheduledTime: "2026-11-06T09:40:00Z" });
    expect(published[0]?.MetricData[0]?.Timestamp).toEqual(new Date("2026-11-06T09:40:00Z"));
  });

  test("reads each target through an RPC for its own URL, built once for every run", async () => {
    const rpc = new FakeRpc({ [FEE]: 1n });
    rpc.balances.set(FEE, 1_010_000_000n);
    const asked: string[] = [];
    const handler = createHandler({
      env,
      rpcFor: (url) => {
        asked.push(url);
        return rpc;
      },
      publish: async () => {},
      log: () => {},
    });
    await handler({});
    await handler({});
    expect(asked).toEqual([RPC]);
  });

  test("resolves to nothing the runtime can't serialize: a result with bigints failed every run", async () => {
    const rpc = new FakeRpc({ [FEE]: 1n });
    rpc.balances.set(FEE, 1_010_000_000n);
    const handler = createHandler({
      env,
      rpcFor: () => rpc,
      publish: async () => {},
      log: () => {},
    });
    const result = await handler({});
    expect(result).toBeUndefined();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("refuses to start without its targets", () => {
    expect(() => createHandler({ env: {}, publish: async () => {} })).toThrow(/WATCH_TARGETS/);
  });

  test("builds a Stellar RPC for the target's URL by default", () => {
    expect(stellarRpc(RPC).serverURL.toString()).toBe(`${RPC}/`);
  });
});
