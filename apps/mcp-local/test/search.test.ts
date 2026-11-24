import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { CATALOG, startFakeCatalog, type FakeCatalog } from "./fake-catalog.js";
import { fakeScheme, USDC } from "./fake-seller.js";

/** What the tool returns, loosely typed for assertions. */
interface Payload {
  items: {
    resource: string;
    description?: string;
    serviceName?: string;
    accepts: { network: string }[];
    input?: Record<string, unknown>;
  }[];
  partialResults: boolean;
  pagination: { limit: number; cursor: string | null };
  error: { code: string; message: string };
}

let catalog: FakeCatalog;
let client: Client;
let logs: string[];

async function connect() {
  catalog = await startFakeCatalog();
  logs = [];
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const log = (message: string) => logs.push(message);
  await createServer({
    discoveryUrl: catalog.url,
    timeoutMs: 500,
    maxResponseBytes: 1_000,
    log,
  }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  // A real MCP client lists the tools first, and then checks results against their output schemas.
  await client.listTools();
}

beforeEach(() => connect());

afterEach(async () => {
  await client.close();
  await catalog.close();
});

async function call(args: Record<string, unknown>) {
  const result = await client.callTool({ name: "search_resources", arguments: args });
  // Text content mirrors the structured result for clients that only read text.
  const [first] = result.content as { type: string; text: string }[];
  const data = JSON.parse(first!.text) as Payload;
  // A result carries the same data as structured content; an error carries it as text only.
  if (!result.isError) expect(data).toEqual(result.structuredContent);
  return { isError: result.isError, structuredContent: data };
}

describe("search_resources: the tool", () => {
  it("is read-only, reaches the outside world, and says where it pays and what it can pay", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "search_resources");
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.openWorldHint).toBe(true);
    expect(tool!.description).toContain("stellar:testnet");
    expect(tool!.description).toContain("call_paid_http");
    expect(tool!.description).toContain("MCP");
  });

  it("is offered also when the server has a payment key", async () => {
    const dailyDir = await mkdtemp(join(tmpdir(), "search-test-"));
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createServer({
        discoveryUrl: catalog.url,
        timeoutMs: 500,
        maxResponseBytes: 1_000,
        log: () => {},
        payment: {
          schemes: [{ network: "stellar:testnet", client: fakeScheme() }],
          payer: "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          assets: { [USDC]: { maxPerCall: 20_000n, daily: 15_000n } },
          dailyDir,
          now: () => new Date("2026-10-13T12:00:00Z"),
        },
      }).connect(serverSide);
      const paying = new Client({ name: "test", version: "0.0.0" });
      await paying.connect(clientSide);
      const { tools } = await paying.listTools();
      const tool = tools.find((t) => t.name === "search_resources");
      expect(tool).toBeDefined();
      expect(tool!.description).toContain("stellar:testnet");
      await paying.close();
    } finally {
      await rm(dailyDir, { recursive: true, force: true });
    }
  });
});

describe("search_resources: input", () => {
  it.each([
    [{ query: "weather" }],
    [{ query: "weather", type: "http" }],
    [{ query: "weather", type: "mcp" }],
    [{ query: "weather", payTo: "GSELLERA" }],
    [{ query: "weather", scheme: "exact" }],
    [{ query: "weather", network: "stellar:testnet" }],
    [{ query: "weather", network: "stellar:pubnet" }],
    [{ query: "weather", extensions: "bazaar" }],
    [{ query: "weather", limit: 5 }],
    [{ query: "weather", cursor: "abc" }],
    [
      {
        query: "hourly forecast",
        type: "http",
        payTo: "GSELLERA",
        scheme: "exact",
        network: "stellar:pubnet",
        extensions: "bazaar",
        limit: 3,
        cursor: "c1",
      },
    ],
  ])("sends exactly the given inputs %j as query parameters, in one request", async (args) => {
    const { isError } = await call(args);
    expect(isError).toBeFalsy();
    expect(catalog.searchQueries).toHaveLength(1);
    expect(catalog.queries).toHaveLength(0);
    // No network is added: without one the route searches both networks.
    expect(Object.fromEntries(catalog.searchQueries[0]!)).toEqual(
      Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])),
    );
  });

  it("sends no network parameter when the agent names none", async () => {
    await call({ query: "weather" });
    expect(catalog.searchQueries[0]!.has("network")).toBe(false);
  });

  it.each([
    [{}],
    [{ query: 42 }],
    [{ query: "weather", type: "a2a" }],
    [{ query: "weather", network: "eip155:8453" }],
    [{ query: "weather", limit: 0 }],
    [{ query: "weather", limit: -1 }],
    [{ query: "weather", limit: 1.5 }],
    [{ query: "weather", cursor: 7 }],
  ])("rejects malformed input %j before calling the catalog", async (args) => {
    const result = await client.callTool({ name: "search_resources", arguments: args });
    expect(result.isError).toBe(true);
    expect(catalog.searchQueries).toHaveLength(0);
  });

  it.each([[{ query: "weather", offset: 20 }], [{ query: "weather", netwrok: "stellar:pubnet" }]])(
    "refuses an argument the tool does not have, naming it: %j",
    async (args) => {
      // A misspelt optional argument would otherwise be dropped and the call run without it.
      const result = await client.callTool({ name: "search_resources", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(Object.keys(args).at(-1));
      expect(catalog.searchQueries).toHaveLength(0);
    },
  );
});

describe("search_resources: output", () => {
  it("returns the route's resources in the route's order, trimmed as list_resources trims them", async () => {
    // The route's ranking decides the order; the tool must not re-sort.
    catalog.searchResources = [CATALOG[4]!, CATALOG[2]!, CATALOG[0]!, CATALOG[1]!];
    const { isError, structuredContent } = await call({ query: "weather" });
    expect(isError).toBeFalsy();
    expect(structuredContent.items).toHaveLength(4);
    expect(structuredContent.items[0]).toEqual({
      resource: "https://weather.example.com/cities/:",
      type: "http",
      description: "City details",
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          amount: "5000",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          payTo: "GSELLERA",
        },
      ],
      input: { type: "http", method: "GET" },
    });
    expect(structuredContent.items[2]).toEqual({
      resource: "https://weather.example.com/forecast",
      type: "http",
      description: "Hourly forecast for a city",
      serviceName: "Weather",
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          amount: "10000",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          payTo: "GSELLERA",
        },
      ],
      input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } },
    });
    // An entry without the bazaar extension has no input.
    expect(structuredContent.items[3]!.input).toBeUndefined();
    expect(structuredContent.items[3]!.accepts[0]!.network).toBe("stellar:pubnet");
  });

  it("cuts seller-written text to 500 characters", async () => {
    catalog.searchResources = [
      { ...CATALOG[2]!, resource: `https://quotes.example.com/${"z".repeat(2_000)}` },
    ];
    const { structuredContent } = await call({ query: "quote" });
    // The URL is kept whole, as list_resources keeps it: the catalog bounds it on intake.
    expect(structuredContent.items[0]!.resource).toHaveLength(2_027);
    expect(structuredContent.items[0]!.description).toHaveLength(500);
    expect(structuredContent.items[0]!.serviceName).toHaveLength(500);
    expect(structuredContent.items[0]!.input).toEqual({
      type: "mcp",
      toolName: "quote",
      inputSchema: { type: "object" },
    });
  });

  it("trims an entry exactly as list_resources trims the same entry", async () => {
    const long = { ...CATALOG[2]!, resource: `https://quotes.example.com/${"z".repeat(2_000)}` };
    const both = await startFakeCatalog([long]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({
      discoveryUrl: both.url,
      timeoutMs: 500,
      maxResponseBytes: 1_000,
      log: () => {},
    }).connect(serverSide);
    const other = new Client({ name: "test", version: "0.0.0" });
    await other.connect(clientSide);
    await other.listTools();
    const listed = await other.callTool({ name: "list_resources", arguments: {} });
    const searched = await other.callTool({
      name: "search_resources",
      arguments: { query: "quote" },
    });
    const listedItems = (listed.structuredContent as unknown as Payload).items;
    const searchedItems = (searched.structuredContent as unknown as Payload).items;
    expect(searchedItems).toEqual(listedItems);
    await other.close();
    await both.close();
  });

  it("passes partialResults and pagination through as the route sent them", async () => {
    catalog.searchResources = [CATALOG[0]!];
    catalog.partialResults = false;
    catalog.cursor = "c1";
    const { structuredContent } = await call({ query: "weather" });
    expect(structuredContent.partialResults).toBe(false);
    expect(structuredContent.pagination).toEqual({ limit: 1, cursor: "c1" });
  });

  it("passes a null cursor and partialResults true through", async () => {
    catalog.partialResults = true;
    catalog.cursor = null;
    const { structuredContent } = await call({ query: "weather" });
    expect(structuredContent.partialResults).toBe(true);
    expect(structuredContent.pagination).toEqual({ limit: CATALOG.length, cursor: null });
  });

  it("returns an empty page when the route finds nothing", async () => {
    catalog.searchResources = [];
    const { isError, structuredContent } = await call({ query: "nothing matches" });
    expect(isError).toBeFalsy();
    expect(structuredContent.items).toEqual([]);
    expect(structuredContent.pagination).toEqual({ limit: 0, cursor: null });
  });

  it("pages: the cursor of the first call, given back, is sent on the second", async () => {
    catalog.searchResources = [CATALOG[0]!];
    catalog.cursor = "c1";
    const first = await call({ query: "weather", limit: 1 });
    expect(first.structuredContent.pagination.cursor).toBe("c1");

    catalog.searchResources = [CATALOG[4]!];
    catalog.cursor = null;
    const second = await call({
      query: "weather",
      limit: 1,
      cursor: first.structuredContent.pagination.cursor,
    });
    expect(catalog.searchQueries).toHaveLength(2);
    expect(catalog.searchQueries[1]!.get("cursor")).toBe("c1");
    expect(second.structuredContent.items.map((i) => i.resource)).toEqual([
      "https://weather.example.com/cities/:",
    ]);
    expect(second.structuredContent.pagination.cursor).toBeNull();
  });
});

describe("search_resources: errors", () => {
  it("returns invalid_cursor when the route refuses the cursor", async () => {
    catalog.badParam = "cursor";
    const { isError, structuredContent } = await call({ query: "weather", cursor: "stale" });
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("invalid_cursor");
    expect(typeof structuredContent.error.message).toBe("string");
  });

  it.each([["query"], ["limit"], ["type"]])(
    "returns invalid_input when the route refuses the parameter %s",
    async (param) => {
      catalog.badParam = param;
      const { isError, structuredContent } = await call({ query: "weather" });
      expect(isError).toBe(true);
      expect(structuredContent.error.code).toBe("invalid_input");
      expect(typeof structuredContent.error.message).toBe("string");
    },
  );

  it("returns invalid_input when a catalog answers 400 without the route's body", async () => {
    // Another operator's catalog may refuse a search in plain text; the request is still the cause.
    catalog.failWith = 400;
    const { isError, structuredContent } = await call({ query: "weather" });
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("invalid_input");
  });

  it("returns upstream_error, without the route's response body, when the route answers 500", async () => {
    catalog.failWith = 500;
    const { isError, structuredContent } = await call({ query: "weather" });
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("upstream_error");
    expect(typeof structuredContent.error.message).toBe("string");
    expect(JSON.stringify(structuredContent)).not.toContain("catalog body");

    // The server keeps serving.
    catalog.failWith = undefined;
    const next = await call({ query: "weather" });
    expect(next.isError).toBeFalsy();
    expect(next.structuredContent.items).toHaveLength(CATALOG.length);
  });

  it("returns upstream_error when the route answers a malformed body", async () => {
    catalog.malformed = true;
    const { isError, structuredContent } = await call({ query: "weather" });
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("upstream_error");
  });

  it("returns upstream_error within the time limit when the route does not answer, then serves the next call", async () => {
    catalog.hang = true;
    const started = Date.now();
    const { isError, structuredContent } = await call({ query: "weather" });
    // timeoutMs is 500; the margin covers a slow test machine.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("upstream_error");

    catalog.hang = false;
    const next = await call({ query: "weather" });
    expect(next.isError).toBeFalsy();
    expect(catalog.searchQueries).toHaveLength(2);
  });

  it("returns upstream_error when the route is down", async () => {
    const down = await startFakeCatalog();
    const downUrl = down.url;
    await down.close();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({
      discoveryUrl: downUrl,
      timeoutMs: 500,
      maxResponseBytes: 1_000,
      log: () => {},
    }).connect(serverSide);
    const other = new Client({ name: "test", version: "0.0.0" });
    await other.connect(clientSide);
    await other.listTools();
    const result = await other.callTool({
      name: "search_resources",
      arguments: { query: "weather" },
    });
    expect(result.isError).toBe(true);
    const [first] = result.content as { type: string; text: string }[];
    expect((JSON.parse(first!.text) as Payload).error.code).toBe("upstream_error");
    await other.close();
  });
});
