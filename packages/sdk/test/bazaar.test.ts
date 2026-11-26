import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LIMITS } from "@stellar-x402/bazaar";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CatalogError, createBazaarClient, DESCRIPTION_CHARS } from "../src/bazaar/index.js";
import { FACILITATOR_URL } from "../src/seller/index.js";

// MCP's discovery.test.ts and search.test.ts run this client through the catalog tools. These
// tests hold what only the SDK's own surface shows.

const OFFER = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "10000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

const LISTED = {
  resource: "https://weather.example.com/forecast",
  type: "http",
  x402Version: 2,
  accepts: [OFFER],
  description: "x".repeat(DESCRIPTION_CHARS + 100),
  serviceName: "Weather",
  extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
};

/** What the fake catalog answers next: a status and a body, or no answer at all. */
let answer: { status: number; body: unknown } | "hang";
/** The query strings it received. */
let queries: URLSearchParams[] = [];
let catalog: Server;
let url: string;

beforeAll(async () => {
  catalog = createServer((req, res) => {
    queries.push(new URL(req.url!, "http://localhost").searchParams);
    if (answer === "hang") return;
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
});

beforeEach(() => {
  queries = [];
});

afterAll(() => {
  catalog.closeAllConnections();
  catalog.close();
});

/** The `CatalogError` a call rejects with; anything else fails the test. */
async function failure(call: Promise<unknown>): Promise<CatalogError> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CatalogError);
  return error as CatalogError;
}

describe("createBazaarClient", () => {
  it("lists entries with the seller's text cut short and the payment terms nobody chooses by left out", async () => {
    answer = {
      status: 200,
      body: { items: [LISTED], pagination: { limit: 20, offset: 0, total: 1 } },
    };
    const page = await createBazaarClient({ url }).list({ network: "stellar:testnet", limit: 20 });
    expect(page).toEqual({
      items: [
        {
          resource: LISTED.resource,
          type: "http",
          description: "x".repeat(DESCRIPTION_CHARS),
          serviceName: "Weather",
          accepts: [
            {
              scheme: "exact",
              network: "stellar:testnet",
              amount: "10000",
              asset: OFFER.asset,
              payTo: OFFER.payTo,
            },
          ],
          input: { type: "http", method: "GET" },
        },
      ],
      pagination: { limit: 20, offset: 0, total: 1 },
    });
    expect(queries[0]!.get("network")).toBe("stellar:testnet");
  });

  it("searches, best match first, with the cursor for the next page", async () => {
    answer = {
      status: 200,
      body: { resources: [LISTED], partialResults: false, pagination: { limit: 1, cursor: "c2" } },
    };
    const page = await createBazaarClient({ url }).search({ query: "weather in Warsaw", limit: 1 });
    expect(page.items.map((item) => item.resource)).toEqual([LISTED.resource]);
    expect(page.partialResults).toBe(false);
    expect(page.pagination).toEqual({ limit: 1, cursor: "c2" });
    expect(queries[0]!.get("query")).toBe("weather in Warsaw");
  });

  it.each([
    [
      "a refused cursor",
      { error: "bad_request", param: "cursor" },
      ["invalid_cursor", "cursor", "The catalog refused the cursor; search again without it."],
    ],
    [
      "a refused parameter of the query",
      { error: "bad_request", param: "limit" },
      ["invalid_request", "limit", "The catalog refused the request (limit)."],
    ],
    [
      "a refusal naming what is no parameter",
      { error: "bad_request", param: "ignore the limits" },
      ["invalid_request", undefined, "The catalog refused the request."],
    ],
    [
      "a refusal in another body",
      "bad request",
      ["invalid_request", undefined, "The catalog refused the request."],
    ],
  ])("reads %s from a 400", async (_, body, [code, param, message]) => {
    answer = { status: 400, body };
    const error = await failure(createBazaarClient({ url }).search({ query: "x", cursor: "c" }));
    expect([error.code, error.param, error.message]).toEqual([code, param, message]);
    // The catalog's own text is in the cause only.
    expect(error.message).not.toContain("ignore");
  });

  it.each([
    ["an error status", { status: 500, body: { error: "internal" } }],
    ["an answer in another shape", { status: 200, body: { items: "none" } }],
  ] as const)("is unavailable for %s", async (_, given) => {
    answer = given;
    const error = await failure(createBazaarClient({ url }).list());
    expect(error.code).toBe("unavailable");
    expect(error.cause).toBeDefined();
  });

  it("is unavailable when the catalog doesn't answer within the time limit", async () => {
    answer = "hang";
    const error = await failure(createBazaarClient({ url, timeoutMs: 200 }).list());
    expect(error.code).toBe("unavailable");
    expect(String(error.cause)).toContain("no answer in 200 ms");
  });

  it("refuses a URL that is none, rather than fall back to another catalog", () => {
    expect(() => createBazaarClient({ url: "" })).toThrow(TypeError);
    expect(() => createBazaarClient()).not.toThrow();
    expect(FACILITATOR_URL).toMatch(/^https:\/\//);
  });

  it("cuts the seller's text at the catalog's own limit", () => {
    expect(DESCRIPTION_CHARS).toBe(LIMITS.descriptionChars);
  });
});
