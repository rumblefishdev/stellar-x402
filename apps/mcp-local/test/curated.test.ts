import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { CATALOG, startFakeCatalog, type FakeCatalog } from "./fake-catalog.js";

/** What the tools return, loosely typed for assertions. */
interface Payload {
  items: { resource: string; curated?: boolean }[];
}

/** The catalog's weather forecast, curated; its city details, not; its quotes, without the field. */
const ITEMS = [
  { ...CATALOG[0]!, curated: true },
  { ...CATALOG[4]!, curated: false },
  CATALOG[3]!,
] as DiscoveryResource[];

let catalog: FakeCatalog;
let client: Client;

beforeEach(async () => {
  catalog = await startFakeCatalog(ITEMS);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({
    discoveryUrl: catalog.url,
    timeoutMs: 500,
    maxResponseBytes: 10_000,
    log: () => {},
  }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  // A real MCP client lists the tools first, and then checks results against their output schemas.
  await client.listTools();
});

afterEach(async () => {
  await client.close();
  await catalog.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError, structuredContent: result.structuredContent as Payload };
}

describe("curated in the tools' results", () => {
  it("names curated in each tool's item schema, as an optional boolean", async () => {
    const { tools } = await client.listTools();
    for (const name of ["list_resources", "search_resources"]) {
      const schema = tools.find((tool) => tool.name === name)!.outputSchema as unknown as {
        properties: { items: { items: { properties: object; required?: string[] } } };
      };
      expect(schema.properties.items.items.properties, name).toHaveProperty("curated");
      expect(
        (schema.properties.items.items.properties as Record<string, object>).curated,
        name,
      ).toMatchObject({ type: "boolean" });
      expect(schema.properties.items.items.required ?? [], name).not.toContain("curated");
    }
  });

  it("keeps curated on each item list_resources returns, and passes an item without it", async () => {
    const { isError, structuredContent } = await call("list_resources", {
      network: "stellar:testnet",
    });
    expect(isError).toBeFalsy();
    expect(structuredContent.items.map((item) => item.curated)).toEqual([true, false, undefined]);
  });

  it("keeps curated on each item search_resources returns, and passes an item without it", async () => {
    const { isError, structuredContent } = await call("search_resources", { query: "weather" });
    expect(isError).toBeFalsy();
    expect(structuredContent.items.map((item) => item.curated)).toEqual([true, false, undefined]);
  });
});
