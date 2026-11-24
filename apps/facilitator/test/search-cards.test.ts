import { SEARCH_FIELDS_VERSION } from "@stellar-x402/bazaar";
import { describe, expect, it } from "vitest";
import { createSearchCardWriter } from "../src/catalog/search-cards.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SearchCard, SearchCardStore, StaleListing } from "../src/ports/index.js";

const stale = (seq: string, description: string): StaleListing => ({
  seq,
  checkedAt: 7,
  resource: {
    resource: `https://seller.example/${seq}`,
    type: "http",
    x402Version: 2,
    accepts: [],
    lastUpdated: "2026-11-24T00:00:00.000Z",
    description,
  },
});

/** A store whose stale listings are the ones without a card written by this test. */
function memoryStore(listings: StaleListing[], fail?: { write?: Error }) {
  const written: SearchCard[] = [];
  const store: SearchCardStore = {
    stale: async (_rules, limit) =>
      listings.filter((l) => !written.some((card) => card.seq === l.seq)).slice(0, limit),
    write: async (card) => {
      if (fail?.write) throw fail.write;
      written.push(card);
    },
  };
  return { store, written };
}

describe("search card writer", () => {
  it("writes each stale listing's card from its fields, its check and the rules version", async () => {
    const { store, written } = memoryStore([stale("1", "Weather"), stale("2", "Stocks")]);
    const lines: string[] = [];
    const writer = createSearchCardWriter({
      store,
      logger: jsonLogger("debug", (line) => lines.push(line)),
      metrics: memoryMetrics(),
    });
    await writer.runOnce();
    expect(written).toEqual([
      {
        seq: "1",
        checkedAt: 7,
        rules: SEARCH_FIELDS_VERSION,
        fields: { name: "1", tags: "", description: "Weather", parameters: "" },
      },
      {
        seq: "2",
        checkedAt: 7,
        rules: SEARCH_FIELDS_VERSION,
        fields: { name: "2", tags: "", description: "Stocks", parameters: "" },
      },
    ]);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "search_cards_written", written: 2 }),
    );
    // Nothing left: the next pass writes nothing and logs nothing.
    lines.length = 0;
    await writer.runOnce();
    expect(written).toHaveLength(2);
    expect(lines).toEqual([]);
  });

  it("logs and counts a failed pass, and the next pass tries again", async () => {
    const failure = { write: new Error("database down") as Error | undefined };
    const { store, written } = memoryStore([stale("1", "Weather")], failure);
    const lines: string[] = [];
    const metrics = memoryMetrics();
    const writer = createSearchCardWriter({
      store,
      logger: jsonLogger("debug", (line) => lines.push(line)),
      metrics,
    });
    await writer.runOnce();
    expect(metrics.value("search_card_failures_total")).toBe(1);
    expect(lines.join("")).toContain("database down");
    failure.write = undefined;
    await writer.runOnce();
    expect(written.map((card) => card.seq)).toEqual(["1"]);
  });
});
