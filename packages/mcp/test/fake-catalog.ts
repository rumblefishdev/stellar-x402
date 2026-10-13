import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DiscoveryResource, DiscoveryResourcesResponse } from "@x402/extensions/bazaar";

/** Stands in for `GET /discovery/resources` (task 0032) until our facilitator serves it. */

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function accepts(network: string, payTo: string, amount: string) {
  return [
    {
      scheme: "exact",
      network,
      amount,
      asset: USDC,
      payTo,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    },
  ] as DiscoveryResource["accepts"];
}

export const CATALOG: DiscoveryResource[] = [
  {
    resource: "https://weather.example.com/forecast",
    type: "http",
    x402Version: 2,
    accepts: accepts("stellar:testnet", "GSELLERA", "10000"),
    lastUpdated: "2026-10-01T00:00:00.000Z",
    description: "Hourly forecast for a city",
    serviceName: "Weather",
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } },
          output: { type: "json", example: { tempC: 14 } },
        },
      },
    },
  },
  {
    resource: "https://weather.example.com/forecast",
    type: "http",
    x402Version: 2,
    accepts: accepts("stellar:pubnet", "GSELLERA", "10000"),
    lastUpdated: "2026-10-01T00:00:00.000Z",
    description: "Hourly forecast for a city",
  },
  {
    resource: "https://quotes.example.com/mcp",
    type: "mcp",
    x402Version: 2,
    accepts: accepts("stellar:testnet", "GSELLERB", "50000"),
    lastUpdated: "2026-10-02T00:00:00.000Z",
    description: "x".repeat(2_000),
    serviceName: "y".repeat(2_000),
    extensions: {
      bazaar: {
        info: {
          input: { type: "mcp", toolName: "quote", inputSchema: { type: "object" } },
          output: { type: "json" },
        },
      },
    },
  },
  {
    resource: "https://quotes.example.com/mcp",
    type: "mcp",
    x402Version: 2,
    accepts: accepts("stellar:testnet", "GSELLERB", "20000"),
    lastUpdated: "2026-10-02T00:00:00.000Z",
    description: "Price history",
    extensions: {
      bazaar: {
        info: {
          input: { type: "mcp", toolName: "history", inputSchema: { type: "object" } },
          output: { type: "json" },
        },
      },
    },
  },
  {
    // A templated route: the catalog lists it with the parameter name erased (ADR 0008).
    resource: "https://weather.example.com/cities/:",
    type: "http",
    x402Version: 2,
    accepts: accepts("stellar:testnet", "GSELLERA", "5000"),
    lastUpdated: "2026-10-03T00:00:00.000Z",
    description: "City details",
    extensions: {
      bazaar: { info: { input: { type: "http", method: "GET" }, output: { type: "json" } } },
    },
  },
];

function filter(items: DiscoveryResource[], query: URLSearchParams): DiscoveryResourcesResponse {
  const want = (key: string, value: string) => !query.has(key) || query.get(key) === value;
  const matching = items.filter(
    (item) =>
      want("type", item.type) &&
      item.accepts.some((a) => want("payTo", a.payTo) && want("network", a.network)) &&
      // Same rule as the memory catalog store: an own key with a value.
      (!query.has("extensions") ||
        (item.extensions?.[query.get("extensions")!] !== undefined &&
          Object.hasOwn(item.extensions, query.get("extensions")!))),
  );
  const offset = Number(query.get("offset") ?? 0);
  // A real catalog bounds the page size (ADR 0008), so callers must page by what they receive.
  const limit = Math.min(Number(query.get("limit") ?? 20), 50);
  return {
    x402Version: 2,
    items: matching.slice(offset, offset + limit),
    pagination: { limit, offset, total: matching.length },
  };
}

export interface FakeCatalog {
  url: string;
  /** Query strings received, in order. */
  queries: URLSearchParams[];
  /** Answer with this status instead of the catalog. */
  failWith?: number;
  /** Accept the request and never answer. */
  hang?: boolean;
  /** Answer 200 with a body that is not a discovery page. */
  malformed?: boolean;
  close(): Promise<void>;
}

export async function startFakeCatalog(items: DiscoveryResource[] = CATALOG): Promise<FakeCatalog> {
  const queries: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/discovery/resources") {
      res.writeHead(404).end();
      return;
    }
    queries.push(url.searchParams);
    if (fake.hang) return;
    if (fake.failWith) {
      res.writeHead(fake.failWith).end("catalog body that must not reach the agent");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (fake.malformed) {
      res.end(JSON.stringify({ items: "not a list" }));
      return;
    }
    res.end(JSON.stringify(filter(items, url.searchParams)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeCatalog = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    queries,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A hanging request would otherwise keep the server open.
        server.closeAllConnections();
      }),
  };
  return fake;
}
