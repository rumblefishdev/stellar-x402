import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemeNetworkClient } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type PaymentConfig } from "../src/index.js";
import { fakeScheme, NO_TRUSTLINE, startFakeSeller, USDC, type FakeSeller } from "./fake-seller.js";

interface Paid {
  status: number;
  contentType: string | null;
  body: string;
  payment?: { transaction: string; amount: string };
  error: { code: string; message: string };
}

let seller: FakeSeller;
let client: Client;
let logs: string[];

async function connect(
  overrides: Partial<PaymentConfig> = {},
  {
    scheme = fakeScheme(),
    timeoutMs = 5_000,
    allowInsecureLocal = true,
  }: { scheme?: SchemeNetworkClient; timeoutMs?: number; allowInsecureLocal?: boolean } = {},
) {
  logs = [];
  const payment: PaymentConfig = {
    // Testnet only, as the CLI registers it.
    schemes: [{ network: "stellar:testnet", client: scheme }],
    assets: { [USDC]: { maxPerCall: 20_000n, budget: 15_000n } },
    ...overrides,
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const log = (message: string) => logs.push(message);
  const config = { discoveryUrl: "http://unused", timeoutMs, maxResponseBytes: 1_000, log };
  await createServer({ ...config, allowInsecureLocal, payment }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
}

async function reconnect(...args: Parameters<typeof connect>) {
  await client.close();
  await connect(...args);
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
    expect(result.payment).toEqual({
      transaction: "a".repeat(64),
      network: "stellar:testnet",
      asset: USDC,
      amount: "10000",
    });
    expect(seller.payments).toHaveLength(1);
  });

  it("returns a free resource without paying", async () => {
    const result = await pay("/free");
    expect(result.status).toBe(200);
    expect(result.payment).toBeUndefined();
    expect(seller.payments).toHaveLength(0);
  });

  it("cuts the seller's content type to the catalog's limit", async () => {
    seller.contentType = `text/${"x".repeat(300)}`;
    expect((await pay("/free")).contentType).toHaveLength(127);
  });

  it("returns a paid answer without a body", async () => {
    seller.paidStatus = 204;
    const result = await pay();
    expect(result.status).toBe(204);
    expect(result.body).toBe("");
    expect(result.payment).toBeDefined();
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

  it("counts the budget at once, so two calls at once cannot both pass it", async () => {
    const results = await Promise.all([pay(), pay()]);
    expect(results.map((r) => r.error?.code ?? "paid").sort()).toEqual(["over_budget", "paid"]);
    expect(seller.payments).toHaveLength(1);
  });

  it.each([
    ["GET", "call_paid_http"],
    ["GET", "get_resource"],
  ])(
    "returns invalid_input for a %s with a body in %s, without calling the seller",
    async (method, name) => {
      const result = await client.callTool({
        name,
        arguments: { url: `${seller.url}/forecast`, method, body: "{}" },
      });
      expect((result.structuredContent as unknown as Paid).error.code).toBe("invalid_input");
      expect(seller.bodies).toHaveLength(0);
    },
  );

  it("refuses an asset name that is only a property of every object", async () => {
    seller.asset = "constructor";
    expect((await pay()).error.code).toBe("asset_not_allowed");
  });

  it("refuses a payment the seller wants valid for longer than 300 s", async () => {
    seller.maxTimeoutSeconds = 301;
    expect((await pay()).error.code).toBe("unsupported_payment");
    expect(seller.payments).toHaveLength(0);
    seller.maxTimeoutSeconds = 300;
    expect((await pay()).payment).toBeDefined();
  });

  it("pays in another allowed asset when the first one's budget is spent", async () => {
    await reconnect({
      assets: {
        [USDC]: { maxPerCall: 20_000n, budget: 15_000n },
        COTHER: { maxPerCall: 10n, budget: 100n },
      },
    });
    seller.otherOffers = [{ asset: USDC, amount: "10000" }];
    seller.asset = "COTHER";
    seller.price = "1";
    expect((await pay()).payment).toMatchObject({ asset: USDC });
    expect((await pay()).payment).toMatchObject({ asset: "COTHER", amount: "1" });
  });

  it("logs why a settlement header cannot be read, and returns what was paid for", async () => {
    seller.settle = "garbled";
    const result = await pay();
    expect(result.payment).toMatchObject({ transaction: null });
    expect(logs.join()).toContain("cannot be read");
  });

  it("refuses an asset that is not allowed", async () => {
    seller.asset = "CSOMEOTHERTOKEN";
    expect((await pay()).error.code).toBe("asset_not_allowed");
    expect(seller.payments).toHaveLength(0);
  });

  it("pays the offer within the limits when the seller lists several", async () => {
    seller.otherOffers = [
      { asset: "CSOMEOTHERTOKEN", amount: "1" },
      { asset: USDC, amount: "999999" },
    ];
    const result = await pay();
    expect(result.payment).toMatchObject({ asset: USDC, amount: "10000" });
  });

  it.each([
    ["only on a network this server does not pay on", "/forecast", "stellar:pubnet"],
    ["with a 402 that names no terms", "/no-terms", "stellar:testnet"],
  ])("returns unsupported_payment for a seller asking %s", async (_, path, network) => {
    seller.network = network;
    expect((await pay(path)).error.code).toBe("unsupported_payment");
    expect(seller.payments).toHaveLength(0);
  });

  it("returns payment_rejected when the facilitator refuses, and the budget stays spent", async () => {
    seller.settle = "rejected";
    expect((await pay()).error.code).toBe("payment_rejected");
    expect(logs.join()).toContain("insufficient_funds");
    seller.settle = "success";
    // 10,000 of a 15,000 budget is gone: the seller's word cannot give it back.
    expect((await pay()).error.code).toBe("over_budget");
  });

  it("returns payment_rejected when the seller answers 402 again without a settlement", async () => {
    seller.settle = "refused";
    expect((await pay()).error.code).toBe("payment_rejected");
  });

  it.each([
    ["no settlement header", "missing"],
    ["a settlement without a transaction", "no-transaction"],
  ] as const)(
    "returns what was paid for, without a transaction, when the paid answer has %s",
    async (_, settle) => {
      seller.settle = settle;
      const result = await pay();
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ tempC: 14 });
      expect(result.payment).toMatchObject({ transaction: null, amount: "10000" });
      expect(logs.join()).toContain("no settlement it could show");
      seller.settle = "success";
      expect((await pay()).error.code).toBe("over_budget");
    },
  );

  it.each([
    ["no answer in time", "slow"],
    ["an error status without a settlement", "error"],
  ] as const)("returns payment_unknown when the paid retry gets %s", async (_, settle) => {
    await reconnect({}, { timeoutMs: 300 });
    seller.settle = settle;
    expect((await pay()).error.code).toBe("payment_unknown");
    expect(seller.payments).toHaveLength(1);
    seller.settle = "success";
    expect((await pay()).error.code).toBe("over_budget");
  });

  it.each([
    ["/missing", "resource_not_found"],
    ["/broken", "upstream_error"],
    ["/empty-terms", "unsupported_payment"],
  ])("returns a code, not a response, for an unpaid answer from %s", async (path, code) => {
    expect((await pay(path)).error.code).toBe(code);
    expect(seller.payments).toHaveLength(0);
  });

  it("returns upstream_error when the seller stops sending its response before paying", async () => {
    await reconnect({}, { timeoutMs: 300 });
    expect((await pay("/stall")).error.code).toBe("upstream_error");
  });

  it.each([
    ["a payer without the asset", NO_TRUSTLINE, "insufficient_funds"],
    ["a payer with too little", "HostError: Error(Contract, #10)", "insufficient_funds"],
    ["any other cause", "unexpected signer(s) required: [GX]", "payment_failed"],
  ])(
    "returns a code, with the cause only in the log, when signing fails for %s",
    async (_, cause, code) => {
      await reconnect({}, { scheme: fakeScheme(1, cause) });
      const result = await pay();
      expect(result.error.code).toBe(code);
      expect(result.error.message).not.toContain(cause);
      expect(logs.join()).toContain(cause);
      expect(seller.payments).toHaveLength(0);
      // Nothing was sent, so the amount went back: 10,000 of 15,000 fits again.
      expect((await pay()).payment).toBeDefined();
    },
  );

  it("pays a price equal to the per-call limit, and up to the whole budget", async () => {
    await reconnect({ assets: { [USDC]: { maxPerCall: 10_000n, budget: 20_000n } } });
    expect((await pay()).payment).toBeDefined();
    expect((await pay()).payment).toBeDefined();
    expect((await pay()).error.code).toBe("over_budget");
  });

  it("gives up on a seller slower than the timeout, before paying", async () => {
    await reconnect({}, { timeoutMs: 200 });
    expect((await pay("/slow")).error.code).toBe("upstream_error");
  });

  it.each([
    ["http://example.com/forecast"],
    ["http://127.0.0.1/forecast"],
    ["https://127.0.0.1/forecast"],
    ["https://localhost/forecast"],
    ["https://localhost./forecast"],
    ["https://api.localhost/forecast"],
    ["https://[::1]/forecast"],
    ["https://169.254.169.254/latest"],
    ["https://224.0.0.1/forecast"],
    ["https://[ff02::1]/forecast"],
    ["https://[::ffff:7f00:1]/forecast"],
    ["https://[::ffff:10.0.0.1]/forecast"],
    ["not a url"],
  ])("refuses %s as unsafe without calling it", async (url) => {
    await reconnect({}, { allowInsecureLocal: false });
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

  it("refuses a response larger than the limit, and after paying reports the payment as unknown", async () => {
    seller.body = JSON.stringify({ text: "x".repeat(2_000) });
    expect((await pay("/free")).error.code).toBe("response_too_large");
    expect((await pay()).error.code).toBe("payment_unknown");
    expect(logs.join()).toContain("response_too_large");
  });
});

describe("get_resource", () => {
  async function preview(path = "/forecast?city=Warsaw", url = `${seller.url}${path}`) {
    const result = await client.callTool({
      name: "get_resource",
      arguments: { url, method: "GET" },
    });
    return result.structuredContent as unknown as {
      status: number;
      paymentRequired: {
        resource: { description: string; mimeType: string };
        error: string;
        accepts: { amount: string; asset: string; maxTimeoutSeconds: number }[];
        extensions: { bazaar: { info: { output: unknown } } };
      } | null;
      error: { code: string };
    };
  }

  it("returns the seller's terms and description without paying or touching the budget", async () => {
    const result = await preview();
    expect(result.status).toBe(402);
    expect(result.paymentRequired!.accepts).toEqual([
      expect.objectContaining({ amount: "10000", asset: USDC, maxTimeoutSeconds: 60 }),
    ]);
    expect(result.paymentRequired!.extensions.bazaar.info.output).toEqual({
      type: "json",
      example: { tempC: 14 },
    });
    expect(seller.payments).toHaveLength(0);
    // 10,000 of a 15,000 budget still fits: the preview spent nothing.
    expect((await pay()).payment).toBeDefined();
  });

  it("says a free resource needs no payment", async () => {
    expect(await preview("/free")).toEqual({ status: 200, paymentRequired: null });
  });

  it("cuts the seller's text to the catalog's limits", async () => {
    seller.description = "d".repeat(2_000);
    seller.termsError = "e".repeat(2_000);
    seller.contentType = `text/${"x".repeat(300)}`;
    const { paymentRequired } = await preview();
    expect(paymentRequired!.resource.description).toHaveLength(500);
    expect(paymentRequired!.resource.mimeType).toHaveLength(127);
    expect(paymentRequired!.error).toHaveLength(500);
  });

  it.each([
    ["/missing", "resource_not_found"],
    ["/broken", "upstream_error"],
    ["/no-terms", "unsupported_payment"],
    ["/empty-terms", "unsupported_payment"],
    ["/redirect", "unsafe_url"],
  ])("returns a code for %s", async (path, code) => {
    expect((await preview(path)).error.code).toBe(code);
  });

  it("refuses an input schema deeper than the catalog allows", async () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 12; i++) schema = { type: "object", properties: { a: schema } };
    seller.inputSchema = schema;
    expect((await preview()).error.code).toBe("unsupported_payment");
  });

  it("returns upstream_error for terms larger than an HTTP header can carry", async () => {
    seller.description = "d".repeat(40_000);
    expect((await preview()).error.code).toBe("upstream_error");
  });

  it("returns upstream_error when the seller stops sending its response", async () => {
    await reconnect({}, { timeoutMs: 300 });
    expect((await preview("/stall")).error.code).toBe("upstream_error");
  });

  it("sends the body, for a price that depends on it", async () => {
    await client.callTool({
      name: "get_resource",
      arguments: { url: `${seller.url}/forecast`, method: "POST", body: '{"days":3}' },
    });
    expect(seller.bodies.at(-1)).toBe('{"days":3}');
    expect(seller.payments).toHaveLength(0);
  });

  it("refuses an unsafe URL without calling it", async () => {
    await reconnect({}, { allowInsecureLocal: false });
    expect((await preview("", "https://127.0.0.1/forecast")).error.code).toBe("unsafe_url");
  });

  it("gives up on a seller slower than the timeout", async () => {
    await reconnect({}, { timeoutMs: 200 });
    expect((await preview("/slow")).error.code).toBe("upstream_error");
  });
});

describe("without payment config", () => {
  beforeEach(async () => {
    await client.close();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const config = { discoveryUrl: "http://unused", timeoutMs: 5_000, maxResponseBytes: 1_000 };
    await createServer({ ...config, allowInsecureLocal: true, log: () => {} }).connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  it("lists and previews, but offers no call_paid_http tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_resources", "get_resource"]);
  });

  it("previews a resource's terms without a key", async () => {
    const result = await client.callTool({
      name: "get_resource",
      arguments: { url: `${seller.url}/forecast`, method: "GET" },
    });
    expect((result.structuredContent as { status: number }).status).toBe(402);
    expect(seller.payments).toHaveLength(0);
  });
});
