import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import type { SearchDiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { CatalogKey } from "../src/ports/index.js";
import type { Embedder } from "../src/ports/embedder.js";
import type { Settle } from "../src/settlement/settle.js";
import type { Verify } from "../src/settlement/verify.js";
import { start, type Started } from "../src/start.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";
import { QUERY_VECTOR, setVector, unitVector } from "./vectors.js";

// The cases with vectors stored need the `vector` extension (pgvector) in the test database.

const SERVED = STELLAR_NETWORKS.testnet;

/**
 * Listings by host: their description holds a marker the fake embedder reads, so a vector it makes
 * for a listing's text is the one seeded for it. `cos` is the cosine to the query's vector; null:
 * the model fails on this listing, so it never has a vector.
 */
const LISTINGS = [
  { host: "a", description: "weather alpha", cos: 0.95 },
  { host: "b", description: "tides bravo", cos: 0.9 },
  { host: "c", description: "weather charlie", cos: 0.7 },
  { host: "n", description: "weather novector", cos: null },
  { host: "s", description: "stocks sierra", cos: 0.1 },
  { host: "w", description: "weather whiskey", cos: 0.3 },
] as const;
const MARKERS = ["alpha", "bravo", "charlie", "novector", "sierra", "whiskey"] as const;

const key = (host: string): CatalogKey => ({
  network: SERVED,
  payTo: "GB",
  method: "GET",
  resourceUrl: `https://${host}.seller.example/x`,
});

/** The fake search model: queries get the query vector, listings their seeded one. */
const model = {
  name: "granite-test",
  down: undefined as Error | undefined,
  queries: [] as string[],
};
const embedder: Embedder = {
  embed: vi.fn(async (text: string) => {
    if (model.down) throw model.down;
    const marker = MARKERS.findIndex((m) => text.includes(m));
    if (marker === -1) {
      model.queries.push(text);
      return { model: model.name, vector: QUERY_VECTOR };
    }
    const cos = LISTINGS[marker]!.cos;
    if (cos === null) throw new Error("no vector for this listing");
    return { model: model.name, vector: unitVector(cos) };
  }),
};
afterEach(() => {
  model.down = undefined;
  model.name = "granite-test";
  model.queries.length = 0;
  vi.mocked(embedder.embed).mockClear();
});

const hostsOf = (body: SearchDiscoveryResourcesResponse) =>
  body.resources.map((item) => new URL(item.resource).hostname.split(".")[0]);
const decode = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;

/**
 * The app on a database of its own holding {@link LISTINGS}, their vectors stored when `vectors`,
 * searching with `using` (the fake model unless given).
 */
function app(vectors: boolean, using?: () => Promise<Embedder>) {
  const db = testDatabase();
  const lines: string[] = [];
  const metrics = memoryMetrics();
  let started: Started | undefined;
  let url = "";

  beforeAll(async () => {
    const env = {
      ...signerEnv(Keypair.random().publicKey()),
      DATABASE_URL: db.urlFor(db.schema),
      CHANNELS: Keypair.random().publicKey(),
      CLIENT_IP: "socket",
      SEARCH_MODEL_URL: "http://127.0.0.1:9",
      // Every case calls from one address; rate-limit.test.ts covers the shared limit.
      RATE_LIMIT_DISCOVERY: "1000000",
    };
    const config = { ...parseConfig(env), port: 0 };
    const stores = db.stores();
    for (const { host, description, cos } of LISTINGS) {
      const k = key(host);
      await stores.catalog.upsert({
        keyVersion: CATALOG_KEY_VERSION,
        ledger: null,
        checkedAt: 1,
        key: k,
        resource: {
          resource: k.resourceUrl,
          type: "http",
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: SERVED,
              asset: "CASSET",
              amount: "1",
              payTo: "GB",
              maxTimeoutSeconds: 60,
              extra: {},
            },
          ],
          lastUpdated: "2026-11-24T00:00:00.000Z",
          description,
        },
      });
      if (vectors && cos !== null) await setVector(db.pool, k, model.name, unitVector(cos));
    }
    started = await start({
      config,
      logger: jsonLogger("debug", (line) => lines.push(line)),
      metrics,
      stores,
      embedder: using ? await using() : embedder,
      verify: vi.fn<Verify>(),
      settle: vi.fn<Settle>(),
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
    } as Parameters<typeof start>[0]);
    url = `http://127.0.0.1:${started.port}`;
  });
  afterAll(() => started?.close());

  const search = async (query: string) => {
    const response = await fetch(`${url}/discovery/search?${query}`);
    return { response, body: (await response.json()) as SearchDiscoveryResourcesResponse };
  };
  return { search, lines, metrics };
}

describe("GET /discovery/search by meaning, vectors stored (0120 G, I)", () => {
  const { search } = app(true);

  it("ranks fused when the model answers, with every match and no partial results (G)", async () => {
    const { response, body } = await search("query=weather&limit=10");
    expect(response.status).toBe(200);
    // a: meaning 1, words 1; c: meaning 3, words 2; b: meaning 2 only. s and w are below 0.60, so
    // not matches, though w holds the word; n holds it but has no vector (ADR 0014).
    expect(hostsOf(body)).toEqual(["a", "c", "b"]);
    expect(body.partialResults).toBe(false);
    expect(body.pagination).toEqual({ limit: 3, cursor: null });
  });

  it("finds a listing by meaning alone, with no query word in it (G)", async () => {
    const { body } = await search("query=zebra");
    expect(hostsOf(body)).toEqual(["a", "b", "c"]);
    expect(body.partialResults).toBe(false);
  });

  it("pages the fused ranking with a cursor that carries the ranking and the model (G, I)", async () => {
    const seen: (string | undefined)[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const { body } = await search(
        `query=weather&limit=1${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      expect(body.partialResults).toBe(false);
      seen.push(...hostsOf(body));
      cursor = body.pagination!.cursor;
      if (cursor === null) break;
      expect(decode(cursor)).toMatchObject({ ranking: "fused", model: "granite-test" });
    }
    expect(seen).toEqual(["a", "c", "b"]);
  });

  it("answers by words alone when the model fails, listings without a vector included (H)", async () => {
    model.down = new Error("model down");
    const { body } = await search("query=weather&limit=10");
    // b holds no query word; w, below 0.60 by meaning, holds one.
    expect(hostsOf(body).sort()).toEqual(["a", "c", "n", "w"]);
    expect(body.partialResults).toBe(true);
  });

  it("refuses a fused cursor once search answers by words alone (I)", async () => {
    const first = await search("query=weather&limit=1");
    model.down = new Error("model down");
    const { response, body } = await search(
      `query=weather&limit=1&cursor=${first.body.pagination!.cursor}`,
    );
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "bad_request", param: "cursor" });
  });

  it("refuses a fused cursor of another model (I)", async () => {
    const first = await search("query=weather&limit=1");
    model.name = "granite-next";
    const { response, body } = await search(
      `query=weather&limit=1&cursor=${first.body.pagination!.cursor}`,
    );
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "bad_request", param: "cursor" });
  });

  it("answers an empty fused page when nothing matches (G)", async () => {
    // No listing has this payTo.
    const { body } = await search("query=zebra&payTo=GNOBODY");
    expect(body).toEqual({
      x402Version: 2,
      resources: [],
      partialResults: false,
      pagination: { limit: 0, cursor: null },
    });
  });
});

describe("GET /discovery/search and the search model (0120 H, I, J)", () => {
  const { search, lines, metrics } = app(false);

  it("asks the same model for the query's vector, with the query's text (J)", async () => {
    await search(`query=${encodeURIComponent("weather in Kraków")}`);
    expect(model.queries).toEqual(["weather in Kraków"]);
  });

  it("asks the model nothing for a request it refuses, or one nothing can match (J)", async () => {
    await search("query=");
    await search("query=weather&cursor=abc");
    await search("query=weather&scheme=upto");
    // Queries only: the vector pass may be embedding listings meanwhile.
    expect(model.queries).toEqual([]);
  });

  it("answers by words alone when the model fails: same shape, partial, logged and counted (H)", async () => {
    model.down = new Error("model down");
    const before = metrics.value("search_words_only_total");
    const { response, body } = await search("query=weather&limit=10");
    expect(response.status).toBe(200);
    expect(body.x402Version).toBe(2);
    expect(hostsOf(body).sort()).toEqual(["a", "c", "n", "w"]);
    expect(body.partialResults).toBe(true);
    expect(body.pagination).toEqual({ limit: 4, cursor: null });
    expect(metrics.value("search_words_only_total")).toBe(before + 1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "search_words_only",
        error: expect.objectContaining({ message: "model down" }),
      }),
    );
  });

  it("writes a words cursor while the model is down (I)", async () => {
    model.down = new Error("model down");
    const { body } = await search("query=weather&limit=1");
    expect(decode(body.pagination!.cursor!)).toMatchObject({ ranking: "words" });
  });

  it("refuses a words cursor once the model answers again (I)", async () => {
    model.down = new Error("model down");
    const first = await search("query=weather&limit=1");
    model.down = undefined;
    const { response, body } = await search(
      `query=weather&limit=1&cursor=${first.body.pagination!.cursor}`,
    );
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "bad_request", param: "cursor" });
  });
});

describe("GET /discovery/search with a search model that hangs (0120 D, H)", () => {
  let hung: Server | undefined;
  const { search, metrics } = app(false, async () => {
    hung = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => hung!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
    // Imported here, so the cases above run while the adapter does not exist yet.
    const { createSearchModelClient } = await import("../src/adapters/search-model.js");
    return createSearchModelClient({ url, timeoutMs: 100 });
  });
  afterAll(async () => {
    if (!hung) return;
    hung.closeAllConnections();
    await new Promise((resolve) => hung!.close(resolve));
  });

  it("answers by words alone once the model's timeout passes", async () => {
    const started = Date.now();
    const { response, body } = await search("query=weather");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(response.status).toBe(200);
    expect(body.partialResults).toBe(true);
    expect(hostsOf(body).sort()).toEqual(["a", "c", "n", "w"]);
    expect(metrics.value("search_words_only_total")).toBeGreaterThanOrEqual(1);
  });
});
