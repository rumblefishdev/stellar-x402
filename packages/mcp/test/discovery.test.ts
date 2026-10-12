import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { CATALOG, startFakeCatalog, type FakeCatalog } from "./fake-catalog.js";

/** What the tools return, loosely typed for assertions. */
interface Payload {
  items: { description?: string; accepts: { network: string }[] }[];
  pagination: unknown;
  error: { code: string };
}

let catalog: FakeCatalog;
let client: Client;

beforeEach(async () => {
  catalog = await startFakeCatalog();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ discoveryUrl: catalog.url }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

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
    expect(structuredContent.pagination).toEqual({ limit: 20, offset: 0, total: 2 });
    expect(structuredContent.items[0]).toEqual({
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
    });
  });

  it.each([
    [{}, 3],
    [{ type: "mcp" }, 1],
    [{ type: "http", network: "stellar:pubnet" }, 1],
    [{ payTo: "GSELLERB" }, 1],
    [{ scheme: "exact", network: "stellar:testnet" }, 2],
    [{ extensions: "bazaar" }, 2],
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

  it("cuts seller-written text to the catalog's description limit", async () => {
    const { structuredContent } = await call("list_resources", { type: "mcp" });
    expect(structuredContent.items[0]!.description).toHaveLength(500);
  });

  it("rejects malformed input before calling the catalog", async () => {
    // The MCP SDK validates input against the schema and answers with its own protocol error.
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

  it("returns resource_not_found for a URL that is not in the catalog", async () => {
    const { isError, structuredContent } = await call("get_resource", {
      resource: "https://nowhere.example.com/",
    });
    expect(isError).toBe(true);
    expect(structuredContent.error.code).toBe("resource_not_found");
  });

  it("finds an entry on a later page when the catalog returns short pages", async () => {
    await catalog.close();
    const many = Array.from({ length: 250 }, (_, i) => ({
      ...CATALOG[1]!,
      resource: `https://many.example.com/${i}`,
    }));
    catalog = await startFakeCatalog(many);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ discoveryUrl: catalog.url }).connect(serverSide);
    await client.close();
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const { structuredContent } = await call("get_resource", {
      resource: "https://many.example.com/249",
    });
    expect(structuredContent.items).toHaveLength(1);
    expect(catalog.queries.map((q) => q.get("offset"))).toEqual(["0", "50", "100", "150", "200"]);
  });

  it("returns upstream_error when the catalog fails", async () => {
    catalog.failWith = 500;
    const { structuredContent } = await call("get_resource", {
      resource: "https://x.example.com/",
    });
    expect(structuredContent.error.code).toBe("upstream_error");
  });
});
