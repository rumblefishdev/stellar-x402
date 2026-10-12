import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemeNetworkClient } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type PaymentConfig } from "../src/index.js";
import { fakeScheme, startFakeSeller, USDC, type FakeSeller } from "./fake-seller.js";

interface Paid {
  status: number;
  body: string;
  payment?: { transaction: string; amount: string };
  error: { code: string; message: string };
}

let seller: FakeSeller;
let client: Client;
let logs: string[];

async function connect(
  overrides: Partial<PaymentConfig> = {},
  scheme: SchemeNetworkClient = fakeScheme(),
) {
  logs = [];
  const payment: PaymentConfig = {
    schemes: [
      { network: "stellar:testnet", client: scheme },
      { network: "stellar:pubnet", client: scheme },
    ],
    assets: { [USDC]: { maxPerCall: 20_000n, budget: 15_000n } },
    timeoutMs: 5_000,
    maxResponseBytes: 1_000,
    allowInsecureLocal: true,
    ...overrides,
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const log = (message: string) => logs.push(message);
  await createServer({ discoveryUrl: "http://unused", log, payment }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
}

beforeEach(async () => {
  seller = await startFakeSeller();
  await connect();
});

afterEach(async () => {
  await client.close();
  await seller.close();
});

async function pay(path = "/forecast?city=Warsaw", method = "GET") {
  const result = await client.callTool({
    name: "call_paid_http",
    arguments: { url: `${seller.url}${path}`, method },
  });
  return { isError: result.isError, ...(result.structuredContent as unknown as Paid) };
}

describe("call_paid_http", () => {
  it("pays the 402 price and returns the response with the settlement transaction", async () => {
    const result = await pay();
    expect(result.isError).toBeFalsy();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ tempC: 14 });
    expect(result.payment).toMatchObject({ transaction: "a".repeat(64), amount: "10000" });
    expect(seller.payments).toHaveLength(1);
  });

  it("returns a free resource without paying", async () => {
    const result = await pay("/free");
    expect(result.status).toBe(200);
    expect(result.payment).toBeUndefined();
    expect(seller.payments).toHaveLength(0);
  });

  it("refuses a price over the per-call limit before signing anything", async () => {
    seller.price = "20001";
    const result = await pay();
    expect(result.error.code).toBe("over_price_limit");
    expect(seller.payments).toHaveLength(0);
  });

  it("refuses a payment that would exceed the budget", async () => {
    expect((await pay()).payment).toBeDefined();
    expect((await pay()).error.code).toBe("over_budget");
    expect(seller.payments).toHaveLength(1);
  });

  it("reserves the budget, so two calls at once cannot both pass it", async () => {
    const results = await Promise.all([pay(), pay()]);
    expect(results.map((r) => r.error?.code ?? "paid").sort()).toEqual(["over_budget", "paid"]);
    expect(seller.payments).toHaveLength(1);
  });

  it("refuses an asset that is not allowed and a network other than testnet", async () => {
    seller.asset = "CSOMEOTHERTOKEN";
    expect((await pay()).error.code).toBe("asset_not_allowed");
    seller.asset = USDC;
    seller.network = "stellar:pubnet";
    expect((await pay()).error.code).toBe("network_not_allowed");
    expect(seller.payments).toHaveLength(0);
  });

  it("returns payment_rejected and gives the amount back when the facilitator refuses", async () => {
    seller.settle = "rejected";
    const rejected = await pay();
    expect(rejected.error.code).toBe("payment_rejected");
    expect(logs.join()).toContain("insufficient_funds");
    seller.settle = "success";
    // 10,000 of a 15,000 budget fits again only if the refused payment was given back.
    expect((await pay()).payment).toBeDefined();
  });

  it("counts a payment whose outcome is unknown as spent", async () => {
    seller.settle = "missing";
    expect((await pay()).error.code).toBe("payment_unknown");
    seller.settle = "success";
    expect((await pay()).error.code).toBe("over_budget");
  });

  it("returns payment_failed, with the cause only in the log, when signing fails", async () => {
    await client.close();
    await connect({}, fakeScheme(1));
    const result = await pay();
    expect(result.error.code).toBe("payment_failed");
    expect(result.error.message).not.toContain("trustline");
    expect(logs.join()).toContain("trustline");
    expect(seller.payments).toHaveLength(0);
    // Nothing was signed, so the amount was given back: 10,000 of 15,000 fits again.
    expect((await pay()).payment).toBeDefined();
  });

  it("pays a price equal to the per-call limit, and up to the whole budget", async () => {
    await client.close();
    await connect({ assets: { [USDC]: { maxPerCall: 10_000n, budget: 20_000n } } });
    expect((await pay()).payment).toBeDefined();
    expect((await pay()).payment).toBeDefined();
    expect((await pay()).error.code).toBe("over_budget");
  });

  it("gives up on a seller slower than the timeout", async () => {
    await client.close();
    await connect({ timeoutMs: 200 });
    expect((await pay("/slow")).error.code).toBe("upstream_error");
  });

  it.each([
    ["http://example.com/forecast"],
    ["http://127.0.0.1/forecast"],
    ["https://127.0.0.1/forecast"],
    ["https://localhost/forecast"],
    ["https://[::1]/forecast"],
    ["https://169.254.169.254/latest"],
    ["https://[::ffff:7f00:1]/forecast"],
    ["https://[::ffff:10.0.0.1]/forecast"],
    ["not a url"],
  ])("refuses %s as unsafe without calling it", async (url) => {
    await client.close();
    await connect({ allowInsecureLocal: false });
    const result = await client.callTool({
      name: "call_paid_http",
      arguments: { url, method: "GET" },
    });
    expect((result.structuredContent as unknown as Paid).error.code).toBe("unsafe_url");
  });

  it("does not follow a redirect", async () => {
    const result = await pay("/redirect");
    expect(result.error.code).toBe("unsafe_url");
  });

  it("refuses a response larger than the limit", async () => {
    seller.body = JSON.stringify({ text: "x".repeat(2_000) });
    const result = await pay();
    expect(result.error.code).toBe("response_too_large");
  });
});

describe("without payment config", () => {
  it("offers no call_paid_http tool", async () => {
    await client.close();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ discoveryUrl: "http://unused", log: () => {} }).connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_resources", "get_resource"]);
  });
});
