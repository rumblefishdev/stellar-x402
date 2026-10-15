import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { describe, it } from "vitest";
import { startFakeCatalog } from "../../../../packages/mcp/test/fake-catalog.js";
import { code, startServer } from "../src/cli.js";
import { startFakeSeller } from "../src/fakes.js";
import { row } from "../src/results.js";
import { base, catalog, CATALOG, H1, H2, H3, M1, M2, paying, terms } from "./context.js";

describe("catalog", () => {
  it("E-04 lists with filters and paging, passing each filter on, one request per call", async () => {
    const server = await startServer(base());
    const resources = (items: DiscoveryResource[]) => items.map((i) => i.resource);
    const cases: [Record<string, unknown>, DiscoveryResource[], number][] = [
      [{}, CATALOG, 5],
      [{ type: "http" }, [H1, H2, H3], 3],
      [{ type: "mcp", payTo: "GPAYEE1" }, [M1], 1],
      [{ network: "stellar:pubnet" }, [H3], 1],
      [{ extensions: "bazaar" }, [H1, M1], 2],
      [{ limit: 2, offset: 0 }, [H1, H2], 5],
      [{ limit: 2, offset: 4 }, [M2], 5],
      [{ type: "http", network: "stellar:testnet", payTo: "GPAYEE2" }, [H2], 1],
    ];
    for (const [args, items, total] of cases) {
      const before = catalog.queries.length;
      const page = (await server.call("list_resources", args)).value as {
        items: { resource: string }[];
        pagination: { total: number };
      };
      const query = catalog.queries.at(-1)!;
      row(
        "E-04",
        `${JSON.stringify(args)}: entries, total, filters passed, one request`,
        [resources(items), total, true, 1],
        [
          page.items.map((i) => i.resource),
          page.pagination.total,
          Object.entries(args).every(([key, value]) => query.get(key) === String(value)),
          catalog.queries.length - before,
        ],
      );
    }
    const all = (await server.call("list_resources", {})).value as {
      items: { description: string }[];
    };
    row(
      "E-04",
      "a 10,000-character description is cut to 500 (README)",
      500,
      all.items[1]!.description.length,
    );
    await server.close();
  });

  it("E-05 a catalog failure is upstream_error within the time limit, and the server keeps running", async () => {
    const down = await startFakeCatalog(CATALOG);
    await down.close();
    const failing = await startFakeCatalog(CATALOG);
    failing.failWith = 500;
    const malformed = await startFakeCatalog(CATALOG);
    malformed.malformed = true;
    const hanging = await startFakeCatalog(CATALOG);
    hanging.hang = true;
    const variants = [
      ["a", down],
      ["b", failing],
      ["c", malformed],
      ["d", hanging],
    ] as const;
    for (const [id, fake] of variants) {
      // A 1 s time limit, and 1 s of slack for starting the request.
      const server = await startServer(
        base({ STELLAR_X402_DISCOVERY_URL: fake.url, STELLAR_X402_TIMEOUT_MS: "1000" }),
      );
      const begin = Date.now();
      const first = code(await server.call("list_resources", {}));
      const seconds = (Date.now() - begin) / 1000;
      const second = code(await server.call("list_resources", {}));
      row(
        `E-05${id}`,
        "upstream_error twice, the first within 2 s",
        ["upstream_error", "upstream_error", true],
        [first, second, seconds < 2],
      );
      await server.close();
    }
    await Promise.all([failing.close(), malformed.close(), hanging.close()]);
  });

  it("E-06 input failing a schema is the SDK's error and reaches no seller", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const server = await startServer(paying());
    const cases: [string, Record<string, unknown>][] = [
      ["list_resources", { limit: -1 }],
      ["get_resource", { method: "GET" }],
      ["call_paid_http", { url: `${fake.url}/ok`, method: "HEAD" }],
      ["list_resources", { foo: 1 }],
    ];
    for (const [tool, args] of cases) {
      const answer = await server.call(tool, args);
      row(
        "E-06",
        `${tool} ${JSON.stringify(args)}: -32602`,
        [true, true],
        [answer.isError, answer.text.includes("-32602")],
      );
    }
    row("E-06", "requests reaching the seller", 0, fake.requests.length);
    await server.close();
    await fake.close();
  });
});
