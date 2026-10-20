import { Keypair } from "@stellar/stellar-sdk";
import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar, type DiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStores } from "../src/adapters/memory.js";
import { parseConfig } from "../src/config.js";
import { DISCOVERY_LIMIT, MAX_OFFSET, parseDiscoveryQuery } from "../src/http/discovery.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import type { Stores } from "../src/ports/index.js";
import type { Settle } from "../src/settlement/settle.js";
import type { Verify } from "../src/settlement/verify.js";

describe("parseDiscoveryQuery", () => {
  it.each([
    ["no params", {}, { kind: "query", limit: 20, offset: 0 }],
    ["limit and offset", { limit: "5", offset: "10" }, { kind: "query", limit: 5, offset: 10 }],
    ["a limit above the max, clamped", { limit: "101" }, { kind: "query", limit: 100 }],
    ["the deepest offset", { offset: String(MAX_OFFSET) }, { kind: "query", offset: MAX_OFFSET }],
    ["another CAIP-2 network", { network: "eip155:8453" }, { kind: "empty", limit: 20 }],
    ["the scheme we settle", { scheme: "exact" }, { kind: "query" }],
    ["a scheme we never settle", { scheme: "upto" }, { kind: "empty" }],
    ["an unknown param", { foo: "1" }, { kind: "query", ignored: ["foo"] }],
  ])("accepts %s", (_name, raw, expected) => {
    expect(parseDiscoveryQuery(raw)).toMatchObject(expected);
  });

  it.each([
    ["limit=0", { limit: "0" }, "limit"],
    ["a negative limit", { limit: "-1" }, "limit"],
    ["a non-numeric limit", { limit: "abc" }, "limit"],
    ["a fractional limit", { limit: "1.5" }, "limit"],
    ["an exponent", { limit: "1e3" }, "limit"],
    ["hex", { limit: "0x10" }, "limit"],
    ["an empty limit", { limit: "" }, "limit"],
    ["a negative offset", { offset: "-1" }, "offset"],
    ["an offset past the cap", { offset: String(MAX_OFFSET + 1) }, "offset"],
    ["a repeated param", { type: ["mcp", "http"] }, "type"],
    ["a NUL", { payTo: "G\u0000B" }, "payTo"],
    ["a control character", { type: "http\n" }, "type"],
    ["an empty filter", { type: "" }, "type"],
    ["a value over 256 characters", { extensions: "x".repeat(257) }, "extensions"],
    ["a network that isn't CAIP-2", { network: "pubnet" }, "network"],
  ])("refuses %s, naming the param", (_name, raw, param) => {
    expect(parseDiscoveryQuery(raw)).toEqual({ kind: "invalid", param });
  });

  it("hands the store only the filters it knows, typed", () => {
    const parsed = parseDiscoveryQuery({
      type: "http",
      payTo: "GB",
      network: STELLAR_NETWORKS.pubnet,
      extensions: "bazaar",
      scheme: "exact",
      foo: "1",
    });
    expect(parsed).toEqual({
      kind: "query",
      query: {
        type: "http",
        payTo: "GB",
        network: STELLAR_NETWORKS.pubnet,
        extensions: "bazaar",
        limit: DISCOVERY_LIMIT.default,
        offset: 0,
      },
      limit: DISCOVERY_LIMIT.default,
      offset: 0,
      ignored: ["foo"],
    });
  });
});

const N = 30;

/** Entry i: mcp when i % 4 is 0, payTo GB when odd, pubnet when i % 3 is 0, bazaar when i % 5 is 0. */
async function seed(stores: Stores) {
  for (let i = 0; i < N; i++) {
    const network = i % 3 === 0 ? STELLAR_NETWORKS.pubnet : STELLAR_NETWORKS.testnet;
    const payTo = i % 2 ? "GB" : "GA";
    const resourceUrl = `https://seller.example/${i}`;
    await stores.catalog.upsert({
      keyVersion: CATALOG_KEY_VERSION,
      ledger: 1,
      key: { network, payTo, method: "GET", resourceUrl },
      resource: {
        resource: resourceUrl,
        type: i % 4 === 0 ? "mcp" : "http",
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network,
            asset: "CASSET",
            amount: "1",
            payTo,
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
        lastUpdated: "2026-10-20T00:00:00.000Z",
        ...(i % 5 === 0 ? { extensions: { bazaar: { info: { input: { type: "http" } } } } } : {}),
      },
    });
  }
}

const matching = (match: (i: number) => boolean) =>
  Array.from({ length: N }, (_, i) => i).filter(match).length;

describe("GET /discovery/resources", () => {
  const lines: string[] = [];
  const metrics = memoryMetrics();
  let stores: Stores;
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      CHANNELS: Keypair.random().publicKey(),
    };
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    stores = memoryStores();
    await seed(stores);
    app = await start({
      config,
      logger,
      metrics,
      stores,
      verify: vi.fn<Verify>(),
      settle: vi.fn<Settle>(),
      extensionResponses: () => undefined,
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());
  beforeEach(() => {
    lines.length = 0;
  });

  const list = async (query = "") => {
    const response = await fetch(`${url}/discovery/resources${query ? `?${query}` : ""}`, {
      headers: { origin: "https://other.example" },
    });
    return { response, body: (await response.json()) as DiscoveryResourcesResponse };
  };

  it("answers with upstream's list types, the default page and no CORS headers", async () => {
    const { response, body } = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(body.x402Version).toBe(2);
    expect(body.pagination).toEqual({ limit: DISCOVERY_LIMIT.default, offset: 0, total: N });
    expect(body.items).toHaveLength(DISCOVERY_LIMIT.default);
    expect(body.items[0]).toMatchObject({
      resource: "https://seller.example/0",
      accepts: [{ scheme: "exact" }],
      extensions: { bazaar: { info: { input: { type: "http" } } } },
      lastUpdated: "2026-10-20T00:00:00.000Z",
    });
  });

  it.each([
    ["type=mcp", matching((i) => i % 4 === 0)],
    ["payTo=GB", matching((i) => i % 2 === 1)],
    [`network=${STELLAR_NETWORKS.pubnet}`, matching((i) => i % 3 === 0)],
    ["extensions=bazaar", matching((i) => i % 5 === 0)],
    [
      `type=mcp&payTo=GA&network=${STELLAR_NETWORKS.pubnet}&extensions=bazaar`,
      matching((i) => i % 4 === 0 && i % 2 === 0 && i % 3 === 0 && i % 5 === 0),
    ],
    ["scheme=exact", N],
    ["scheme=upto", 0],
    ["network=eip155:8453", 0],
  ])("filters on %s", async (query, total) => {
    const { response, body } = await list(`${query}&limit=100`);
    expect(response.status).toBe(200);
    expect(body.pagination.total).toBe(total);
    expect(body.items).toHaveLength(total);
  });

  it("pages in a stable order, and keeps the total past the end", async () => {
    const first = await list("limit=7");
    const second = await list("limit=7&offset=7");
    const urls = [...first.body.items, ...second.body.items].map((item) => item.resource);
    expect(urls).toEqual(Array.from({ length: 14 }, (_, i) => `https://seller.example/${i}`));
    expect((await list("offset=500")).body).toMatchObject({
      items: [],
      pagination: { limit: 20, offset: 500, total: N },
    });
  });

  it("clamps a limit above the max and reports the limit it used", async () => {
    expect((await list("limit=101")).body.pagination.limit).toBe(DISCOVERY_LIMIT.max);
  });

  it("answers 400 naming the param, before the store", async () => {
    const spy = vi.spyOn(stores.catalog, "list");
    for (const [query, param] of [
      ["limit=-1", "limit"],
      ["type=mcp&type=http", "type"],
      ["payTo=G%00B", "payTo"],
    ]) {
      const { response, body } = await list(query);
      expect(response.status, query).toBe(400);
      expect(body, query).toEqual({ error: "bad_request", param });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores an unknown param, and logs and counts it", async () => {
    const { response, body } = await list("foo=1");
    expect(response.status).toBe(200);
    expect(body.pagination.total).toBe(N);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "discovery_unknown_params", params: ["foo"] }),
    );
    expect(metrics.value("discovery_unknown_params_total")).toBe(1);
  });

  it("answers a store failure with the shared 500", async () => {
    const spy = vi.spyOn(stores.catalog, "list").mockRejectedValueOnce(new Error("store down"));
    const { response, body } = await list();
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "internal_error" });
    spy.mockRestore();
  });

  it("works with upstream's bazaar client, which throws on a 400", async () => {
    const client = withBazaar(new HTTPFacilitatorClient({ url }));
    const page = await client.extensions.bazaar.listResources({
      type: "mcp",
      limit: 3,
      scheme: "exact",
    });
    expect(page.pagination).toEqual({ limit: 3, offset: 0, total: matching((i) => i % 4 === 0) });
    await expect(client.extensions.bazaar.listResources({ limit: -1 })).rejects.toThrow(/400/);
  });
});
