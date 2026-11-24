import { Keypair } from "@stellar/stellar-sdk";
import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar, type SearchDiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSearchCardWriter } from "../src/catalog/search-cards.js";
import { parseConfig } from "../src/config.js";
import { DISCOVERY_LIMIT } from "../src/http/discovery.js";
import { MAX_QUERY_LENGTH, parseSearchQuery } from "../src/http/search.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { Stores } from "../src/ports/index.js";
import type { Settle } from "../src/settlement/settle.js";
import type { Verify } from "../src/settlement/verify.js";
import { start, type Started } from "../src/start.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";

const SERVED = STELLAR_NETWORKS.testnet;
const OTHER = STELLAR_NETWORKS.pubnet;

/** A cursor as the route writes it, for the cases that send one it did not write. */
const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("parseSearchQuery", () => {
  it.each([
    ["a query alone", { query: "weather" }, { kind: "query", limit: 20 }],
    ["a query at the longest", { query: "w".repeat(MAX_QUERY_LENGTH) }, { kind: "query" }],
    ["a limit", { query: "weather", limit: "5" }, { kind: "query", limit: 5 }],
    ["a limit above the max, clamped", { query: "weather", limit: "101" }, { limit: 100 }],
    ["a limit of 0, as 1", { query: "weather", limit: "0" }, { kind: "query", limit: 1 }],
    [
      "both Stellar networks without a filter",
      { query: "weather" },
      { kind: "query", search: { text: "weather", limit: 21 } },
    ],
    [
      "a network, as a filter",
      { query: "weather", network: OTHER },
      { kind: "query", search: { network: OTHER } },
    ],
    ["the scheme we settle", { query: "weather", scheme: "exact" }, { kind: "query" }],
    ["a scheme we never settle", { query: "weather", scheme: "upto" }, { kind: "empty" }],
    ["an extension we never catalog", { query: "w", extensions: "siwx" }, { kind: "empty" }],
    ["an unknown param", { query: "weather", offset: "5" }, { ignored: ["offset"] }],
  ])("accepts %s", (_name, raw, expected) => {
    expect(parseSearchQuery(raw)).toMatchObject(expected);
  });

  it("hands the store the words and the filters that narrow the catalog", () => {
    expect(
      parseSearchQuery({
        query: "weather",
        type: "http",
        payTo: "GB",
        network: SERVED,
        scheme: "exact",
        extensions: "bazaar",
      }),
    ).toEqual({
      kind: "query",
      // One more than the page, to know whether a next page exists.
      search: { text: "weather", type: "http", payTo: "GB", network: SERVED, limit: 21 },
      limit: DISCOVERY_LIMIT.default,
      ignored: [],
    });
  });

  it("accepts a cursor whose rank PostgreSQL wrote with an exponent", () => {
    const cursor = cursorOf({
      ranking: "words",
      rank: "1e+06",
      key: { network: SERVED, payTo: "GB", method: "GET", resourceUrl: "u" },
    });
    expect(parseSearchQuery({ query: "weather", cursor })).toMatchObject({
      kind: "query",
      search: { after: { rank: "1e+06" } },
    });
  });

  it.each([
    ["no query", {}, "query"],
    ["an empty query", { query: "" }, "query"],
    ["a query of spaces", { query: "   " }, "query"],
    ["a query over the longest", { query: "w".repeat(MAX_QUERY_LENGTH + 1) }, "query"],
    ["a query with a NUL", { query: "wea\u0000ther" }, "query"],
    ["a repeated query", { query: ["a", "b"] }, "query"],
    ["a query param in capitals", { Query: "weather" }, "Query"],
    ["a non-numeric limit", { query: "weather", limit: "abc" }, "limit"],
    ["a network that isn't CAIP-2", { query: "weather", network: "pubnet" }, "network"],
    ["a cursor that isn't one", { query: "weather", cursor: "abc" }, "cursor"],
    [
      "a cursor of another ranking",
      {
        query: "weather",
        cursor: cursorOf({
          ranking: "fused",
          rank: "0.1",
          key: { network: SERVED, payTo: "GB", method: "GET", resourceUrl: "u" },
        }),
      },
      "cursor",
    ],
    [
      "a cursor whose rank is beyond what PostgreSQL's real holds",
      {
        query: "weather",
        cursor: cursorOf({
          ranking: "words",
          rank: "1e999",
          key: { network: SERVED, payTo: "GB", method: "GET", resourceUrl: "u" },
        }),
      },
      "cursor",
    ],
    [
      "a cursor whose rank is below what PostgreSQL's real holds",
      {
        query: "weather",
        cursor: cursorOf({
          ranking: "words",
          rank: "1e-999",
          key: { network: SERVED, payTo: "GB", method: "GET", resourceUrl: "u" },
        }),
      },
      "cursor",
    ],
    [
      "a cursor whose rank isn't a number",
      {
        query: "weather",
        cursor: cursorOf({
          ranking: "words",
          rank: "1;",
          key: { network: SERVED, payTo: "GB", method: "GET", resourceUrl: "u" },
        }),
      },
      "cursor",
    ],
  ])("refuses %s, naming the param", (_name, raw, param) => {
    expect(parseSearchQuery(raw)).toEqual({ kind: "invalid", param });
  });
});

/** 25 listings that hold "weather", the first 5 in their name, on both networks; 3 that don't. */
async function seed(stores: Stores) {
  for (let i = 0; i < 28; i++) {
    const network = i % 3 === 0 ? OTHER : SERVED;
    const resourceUrl = `https://seller.example.com/${String(i).padStart(2, "0")}`;
    const words = i < 25 ? "weather forecast" : "stock prices";
    await stores.catalog.upsert({
      keyVersion: CATALOG_KEY_VERSION,
      ledger: null,
      checkedAt: 1,
      key: { network, payTo: "GB", method: "GET", resourceUrl },
      resource: {
        resource: resourceUrl,
        type: "http",
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network,
            asset: "CASSET",
            amount: "1",
            payTo: "GB",
            maxTimeoutSeconds: 60,
            extra: {},
          },
        ],
        lastUpdated: "2026-11-23T00:00:00.000Z",
        ...(i < 5 ? { serviceName: words } : { description: words }),
        extensions: { bazaar: { info: { input: { type: "http" } } } },
      },
    });
  }
}

describe("GET /discovery/search", () => {
  const db = testDatabase();
  const lines: string[] = [];
  const metrics = memoryMetrics();
  let stores: Stores;
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      ...signerEnv(Keypair.random().publicKey()),
      DATABASE_URL: db.urlFor(db.schema),
      CHANNELS: Keypair.random().publicKey(),
      CLIENT_IP: "socket",
      // Every case calls from one address; rate-limit.test.ts covers the shared limit.
      RATE_LIMIT_DISCOVERY: "1000000",
    };
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    stores = db.stores();
    await seed(stores);
    // The listings enter search once their cards are written, as the card writer's pass does.
    await createSearchCardWriter({ store: stores.searchCards, logger, metrics }).runOnce();
    app = await start({
      config,
      logger,
      metrics,
      stores,
      verify: vi.fn<Verify>(),
      settle: vi.fn<Settle>(),
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  const search = async (query: string) => {
    const response = await fetch(`${url}/discovery/search?${query}`);
    return { response, body: (await response.json()) as SearchDiscoveryResourcesResponse };
  };

  it("answers in upstream's search shape, ranked, words alone marked partial", async () => {
    const { response, body } = await search("query=weather&limit=5");
    expect(response.status).toBe(200);
    expect(body.x402Version).toBe(2);
    // Words alone: matches by meaning were not looked for (ADR 0014).
    expect(body.partialResults).toBe(true);
    expect(body.resources.map((item) => item.serviceName)).toEqual(
      Array(5).fill("weather forecast"),
    );
    expect(body.pagination).toEqual({ limit: 5, cursor: expect.any(String) });
  });

  it("pages through every match with the cursor, then answers a null cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const { body } = await search(
        `query=weather&limit=10${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      seen.push(...body.resources.map((item) => item.resource));
      // The number of results in this page, as upstream's type says.
      expect(body.pagination?.limit).toBe(body.resources.length);
      cursor = body.pagination!.cursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("searches both networks without a filter, and one with it", async () => {
    const all = (await search("query=weather&limit=100")).body.resources;
    expect(new Set(all.flatMap((item) => item.accepts.map((offer) => offer.network)))).toEqual(
      new Set([SERVED, OTHER]),
    );
    const other = (await search(`query=weather&limit=100&network=${OTHER}`)).body.resources;
    expect(other.length).toBe(9);
    expect(other.every((item) => item.accepts[0]!.network === OTHER)).toBe(true);
  });

  it("answers no match with an empty page", async () => {
    const { body } = await search("query=zebra");
    expect(body).toEqual({
      x402Version: 2,
      resources: [],
      partialResults: true,
      pagination: { limit: 0, cursor: null },
    });
  });

  it("answers 400 naming the param, before the store", async () => {
    const spy = vi.spyOn(stores.catalog, "search");
    for (const [query, param] of [
      ["", "query"],
      ["query=", "query"],
      ["query=%20%20", "query"],
      [`query=${"w".repeat(MAX_QUERY_LENGTH + 1)}`, "query"],
      ["query=weather&cursor=abc", "cursor"],
      ["query=weather&network=pubnet", "network"],
    ] as const) {
      const { response, body } = await search(query);
      expect(response.status, query).toBe(400);
      expect(body, query).toEqual({ error: "bad_request", param });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("answers a filter nothing can match without the store", async () => {
    const spy = vi.spyOn(stores.catalog, "search");
    const { response, body } = await search("query=weather&scheme=upto");
    expect(response.status).toBe(200);
    expect(body).toEqual({
      x402Version: 2,
      resources: [],
      partialResults: false,
      pagination: { limit: 0, cursor: null },
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores an unknown param, and logs and counts it", async () => {
    const before = metrics.value("discovery_unknown_params_total");
    const { response } = await search("query=weather&offset=5");
    expect(response.status).toBe(200);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "discovery_unknown_params", params: ["offset"] }),
    );
    expect(metrics.value("discovery_unknown_params_total")).toBe(before + 1);
  });

  it("answers a store failure with the shared 500", async () => {
    const spy = vi.spyOn(stores.catalog, "search").mockRejectedValueOnce(new Error("store down"));
    const { response, body } = await search("query=weather");
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "internal_error" });
    spy.mockRestore();
  });

  it("works with upstream's bazaar client", async () => {
    const client = withBazaar(new HTTPFacilitatorClient({ url }));
    const first = await client.extensions.bazaar.search({ query: "weather", limit: 3 });
    expect(first.resources).toHaveLength(3);
    const next = await client.extensions.bazaar.search({
      query: "weather",
      limit: 3,
      cursor: first.pagination!.cursor!,
    });
    expect(next.resources.map((item) => item.resource)).not.toContain(first.resources[0]!.resource);
    await expect(client.extensions.bazaar.search({ query: " " })).rejects.toThrow(/400/);
  });

  // Upstream's e2e Bazaar check of the route, its request and every check it makes:
  // x402-foundation/x402 e2e/extensions/bazaar.ts:231-279 @8827cf19.
  it("passes upstream's e2e search check", async () => {
    const response = await fetch(`${url}/discovery/search?query=${encodeURIComponent("http")}`);
    expect(response.ok).toBe(true);
    const data = (await response.json()) as SearchDiscoveryResourcesResponse;
    expect(typeof data.x402Version).toBe("number");
    expect(Array.isArray(data.resources)).toBe(true);
    if (data.pagination !== undefined && data.pagination !== null)
      expect(typeof data.pagination.limit).toBe("number");
    if (data.partialResults !== undefined) expect(typeof data.partialResults).toBe("boolean");
  });
});
