import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { CATALOG, startFakeCatalog, type FakeCatalog } from "./fake-catalog.js";

/** What the tools return, loosely typed for assertions. */
interface Payload {
  items: {
    method?: string;
    description?: string;
    serviceName?: string;
    accepts: { network: string }[];
  }[];
  pagination: unknown;
  error: { code: string };
}

let catalog: FakeCatalog;
let client: Client;

async function connect(items = CATALOG) {
  catalog = await startFakeCatalog(items);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ discoveryUrl: catalog.url }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
}

async function reconnect(items: DiscoveryResource[]) {
  await client.close();
  await catalog.close();
  await connect(items);
}

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ...CATALOG[1]!,
    resource: `https://many.example.com/${i}`,
  }));

beforeEach(() => connect());

afterEach(async () => {
  await client.close();
  await catalog.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  // Text content mirrors the structured result for clients that only read text.
  const [first] = result.content as { type: string; text: string }[];
  expect(JSON.parse(first!.text)).toEqual(result.structuredContent);
  return {
    isError: result.isError,
    structuredContent: result.structuredContent as unknown as Payload,
  };
}

describe("list_resources", () => {
  it("returns each entry's price, asset, network and description, and the pagination", async () => {
    const { isError, structuredContent } = await call("list_resources", {
      network: "stellar:testnet",
    });
    expect(isError).toBeFalsy();
    expect(structuredContent.pagination).toEqual({ limit: 20, offset: 0, total: 4 });
    expect(structuredContent.items[0]).toEqual({
      resource: "https://weather.example.com/forecast",
      type: "http",
      method: "GET",
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
    });
  });

  it.each([
    [{}, 5],
    [{ type: "mcp" }, 2],
    [{ type: "http", network: "stellar:pubnet" }, 1],
    [{ payTo: "GSELLERB" }, 2],
    [{ type: "http", network: "stellar:testnet" }, 2],
    [{ extensions: "bazaar" }, 4],
    [{ extensions: "constructor" }, 0],
    [{ type: "mcp", network: "stellar:pubnet" }, 0],
    [{ limit: 1, offset: 1 }, 1],
  ])(
    "passes the filters %j to the catalog and returns only matching entries",
    async (args, count) => {
      const { structuredContent } = await call("list_resources", args);
      expect(structuredContent.items).toHaveLength(count);
      expect(Object.fromEntries(catalog.queries[0]!)).toEqual(
        Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])),
      );
    },
  );

  it("cuts seller-written text to the catalog's limits", async () => {
    const { structuredContent } = await call("list_resources", { type: "mcp" });
    expect(structuredContent.items[0]!.description).toHaveLength(500);
    expect(structuredContent.items[0]!.serviceName).toHaveLength(500);
  });

  it("cuts a long tool name to the catalog's tool name limit", async () => {
    const input = { type: "mcp", toolName: "t".repeat(300), inputSchema: {} };
    await reconnect([{ ...CATALOG[2]!, extensions: { bazaar: { info: { input } } } }]);
    const { structuredContent } = await call("list_resources", {});
    expect(structuredContent.items[0]!.method).toHaveLength(128);
  });

  it("rejects malformed input before calling the catalog", async () => {
    // The MCP SDK checks input against the schema before the handler runs and answers in free text.
    const result = await client.callTool({ name: "list_resources", arguments: { limit: -1 } });
    expect(result.isError).toBe(true);
    expect(catalog.queries).toHaveLength(0);
  });

  it("returns upstream_error, without the catalog's response body, when the catalog fails", async () => {
    catalog.failWith = 503;
    const { isError, structuredContent } = await call("list_resources", {});
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("upstream_error");
    expect(JSON.stringify(structuredContent)).not.toContain("catalog body");
  });
});

describe("get_resource", () => {
  it("returns every entry for the URL, with full payment terms and the input schema", async () => {
    const { isError, structuredContent } = await call("get_resource", {
      resource: "https://weather.example.com/forecast",
    });
    expect(isError).toBeFalsy();
    expect(structuredContent.items.map((i) => i.accepts[0]!.network)).toEqual([
      "stellar:testnet",
      "stellar:pubnet",
    ]);
    expect(structuredContent.items[0]).toEqual(CATALOG[0]);
  });

  it("tells apart the tools of one MCP server by their name", async () => {
    const listed = await call("list_resources", { type: "mcp" });
    expect(listed.structuredContent.items.map((i) => i.method)).toEqual(["quote", "history"]);
    const { structuredContent } = await call("get_resource", {
      resource: "https://quotes.example.com/mcp",
    });
    expect(structuredContent.items).toHaveLength(2);
    // get_resource cuts seller text too, not only list_resources.
    expect(structuredContent.items[0]!.description).toHaveLength(500);
  });

  it.each([
    ["a non-canonical form of the URL", "HTTPS://Weather.Example.com:443/forecast?city=Warsaw", 2],
    ["a templated route as listed", "https://weather.example.com/cities/:", 1],
  ])("finds %s", async (_, resource, count) => {
    const { structuredContent } = await call("get_resource", { resource });
    expect(structuredContent.items).toHaveLength(count);
  });

  it("passes the filters to every page it scans", async () => {
    await call("get_resource", {
      resource: "https://weather.example.com/forecast",
      network: "stellar:testnet",
      payTo: "GSELLERA",
    });
    expect(catalog.queries[0]!.get("network")).toBe("stellar:testnet");
    expect(catalog.queries[0]!.get("payTo")).toBe("GSELLERA");
  });

  it("returns upstream_error when the catalog sends an empty page before its end", async () => {
    await reconnect(many(120));
    catalog.emptyFrom = 50;
    const { structuredContent } = await call("get_resource", {
      resource: "https://many.example.com/119",
    });
    expect(structuredContent.error.code).toBe("upstream_error");
    // It stops at the first empty page instead of asking for more.
    expect(catalog.queries).toHaveLength(2);
  });

  it("returns resource_not_found for a URL that is not in the catalog", async () => {
    const { isError, structuredContent } = await call("get_resource", {
      resource: "https://nowhere.example.com/",
    });
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("resource_not_found");
  });

  it("finds an entry on a later page when the catalog returns short pages", async () => {
    await reconnect(many(250));
    const { structuredContent } = await call("get_resource", {
      resource: "https://many.example.com/249",
    });
    expect(structuredContent.items).toHaveLength(1);
    expect(catalog.queries.map((q) => q.get("offset"))).toEqual(["0", "50", "100", "150", "200"]);
  });

  it("returns upstream_error, not resource_not_found, when the catalog is too large to scan", async () => {
    await reconnect(many(2_600));
    const { structuredContent } = await call("get_resource", {
      resource: "https://nowhere.example.com/",
    });
    expect(structuredContent.error.code).toBe("upstream_error");
    expect(catalog.queries).toHaveLength(50);
  });

  it("returns upstream_error when the catalog fails", async () => {
    catalog.failWith = 500;
    const { structuredContent } = await call("get_resource", {
      resource: "https://x.example.com/",
    });
    expect(structuredContent.error.code).toBe("upstream_error");
  });
});
