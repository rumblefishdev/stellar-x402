import type { Request, Response } from "express";
import { describe, expect, test } from "vitest";
import { discoverySearch, SEARCH_SLOW_MS } from "../src/http/search.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { CatalogStore } from "../src/ports/index.js";
import type { Embedder } from "../src/ports/embedder.js";
import { unitVector } from "./vectors.js";

// `search-slow` (ADR 0014): a fused query slower than 1 s is logged and counted, so the alarm comes
// before the 2 s statement timeout turns searches into 500s. A words-only search is not timed.

/** A catalog whose search takes `ms`; nothing else of it is used. */
function slowCatalog(ms: number): CatalogStore {
  return {
    search: () => new Promise((resolve) => setTimeout(() => resolve([]), ms)),
    waitingForVector: async () => false,
  } as unknown as CatalogStore;
}

async function search(catalog: CatalogStore, embedder: Embedder) {
  const lines: string[] = [];
  const metrics = memoryMetrics();
  const handler = discoverySearch(
    catalog,
    embedder,
    jsonLogger("debug", (line) => lines.push(line)),
    metrics,
  );
  let status = 200;
  const res = {
    status: (code: number) => ((status = code), res),
    json: () => res,
    setHeader: () => res,
  } as unknown as Response;
  await handler({ query: { query: "weather" } } as unknown as Request, res, () => {});
  const slow = lines.map((line) => JSON.parse(line)).filter((line) => line.event === "search_slow");
  return { status, slow, count: metrics.value("search_slow_total") };
}

const model: Embedder = { embed: async () => ({ model: "m", vector: unitVector(0.8) }) };
const down: Embedder = {
  embed: async () => {
    throw new Error("model down");
  },
};

describe("a slow search by meaning", () => {
  test("is logged with its time and counted once over 1 s", async () => {
    expect(SEARCH_SLOW_MS).toBe(1_000);
    const { status, slow, count } = await search(slowCatalog(SEARCH_SLOW_MS + 100), model);
    expect(status).toBe(200);
    expect(count).toBe(1);
    expect(slow).toEqual([
      expect.objectContaining({ level: "warn", ms: expect.any(Number), hits: 0 }),
    ]);
    expect(slow[0].ms).toBeGreaterThan(SEARCH_SLOW_MS);
  });

  test("is neither logged nor counted under 1 s", async () => {
    const { slow, count } = await search(slowCatalog(10), model);
    expect([slow, count]).toEqual([[], 0]);
  });

  test("is not timed when search runs on words alone", async () => {
    const { slow, count } = await search(slowCatalog(SEARCH_SLOW_MS + 100), down);
    expect([slow, count]).toEqual([[], 0]);
  });
});
