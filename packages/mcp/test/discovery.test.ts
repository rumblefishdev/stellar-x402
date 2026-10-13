import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { startFakeCatalog, type FakeCatalog } from "./fake-catalog.js";

/** What the tools return, loosely typed for assertions. */
interface Payload {
  items: {
    description?: string;
    serviceName?: string;
    accepts: { network: string }[];
    input?: Record<string, unknown>;
  }[];
  pagination: unknown;
  error: { code: string };
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

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  // Text content mirrors the structured result for clients that only read text.
  const [first] = result.content as { type: string; text: string }[];
  const data = JSON.parse(first!.text) as Payload;
  // A result carries the same data as structured content; an error carries it as text only.
  if (!result.isError) expect(data).toEqual(result.structuredContent);
  return { isError: result.isError, structuredContent: data };
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
  });

  it("tells apart the tools of one MCP server by the input's tool name", async () => {
    const { structuredContent } = await call("list_resources", { type: "mcp" });
    expect(structuredContent.items.map((i) => i.input?.toolName)).toEqual(["quote", "history"]);
    expect(structuredContent.items[0]!.input).toEqual({
      type: "mcp",
      toolName: "quote",
      inputSchema: { type: "object" },
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
    // The cause goes to the server log, not to the agent.
    expect(logs).toEqual([expect.stringContaining("503")]);
  });

  it("returns upstream_error, with the cause in the log, when the catalog answers a malformed page", async () => {
    catalog.malformed = true;
    const { structuredContent } = await call("list_resources", {});
    expect(structuredContent.error.code).toBe("upstream_error");
    expect(logs).toEqual([expect.stringContaining("items")]);
  });

  it("returns upstream_error when the catalog does not answer in time", async () => {
    catalog.hang = true;
    const { structuredContent } = await call("list_resources", {});
    expect(structuredContent.error.code).toBe("upstream_error");
    expect(logs).toEqual([expect.stringContaining("no answer in 500 ms")]);
  });
});

describe("createServer", () => {
  it.each([[""], ["not a url"]])(
    "refuses the discovery URL %j instead of using another catalog",
    (url) => {
      expect(() =>
        createServer({ discoveryUrl: url, timeoutMs: 500, maxResponseBytes: 1_000, log: () => {} }),
      ).toThrow("discoveryUrl is not a URL");
    },
  );
});
