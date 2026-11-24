import type { SearchFields } from "@stellar-x402/bazaar";
import { describe, expect, it } from "vitest";
import { createSearchCardRewrite } from "../src/catalog/search-cards.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { CardListing, SearchCardStore } from "../src/ports/index.js";

const listing = (seq: string, description: string): CardListing => ({
  seq,
  resource: {
    resource: `https://seller.example/${seq}`,
    type: "http",
    x402Version: 2,
    accepts: [],
    lastUpdated: "2026-11-24T00:00:00.000Z",
    description,
  },
});

/** A store over `listings` in catalog order, recording each card written. */
function memoryStore(listings: CardListing[], write?: (seq: string) => boolean) {
  const written: { seq: string; fields: SearchFields }[] = [];
  const store: SearchCardStore = {
    listings: async (after, limit) =>
      listings.filter((l) => after === null || Number(l.seq) > Number(after)).slice(0, limit),
    write: async (l, fields) => {
      if (write && !write(l.seq)) return false;
      written.push({ seq: l.seq, fields });
      return true;
    },
  };
  return { store, written };
}

const rewrite = (store: SearchCardStore, lines: string[] = [], metrics = memoryMetrics()) =>
  createSearchCardRewrite({
    store,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
  });

describe("search card rewrite", () => {
  it("rewrites every listing's card from its fields, past one page", async () => {
    const all = Array.from({ length: 501 }, (_, i) => listing(String(i + 1), `d${i + 1}`));
    const { store, written } = memoryStore(all);
    const lines: string[] = [];
    await rewrite(store, lines).run();
    expect(written).toHaveLength(501);
    expect(written[0]).toEqual({
      seq: "1",
      fields: { name: "1", tags: "", description: "d1", parameters: "" },
    });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "search_cards_written", written: 501 }),
    );
  });

  it("skips a card that fails, so the listings after it still get theirs", async () => {
    const { store, written } = memoryStore(
      [listing("1", "Weather"), listing("2", "Stocks")],
      (seq) => {
        if (seq === "1") throw new Error("bad card");
        return true;
      },
    );
    const lines: string[] = [];
    const metrics = memoryMetrics();
    await rewrite(store, lines, metrics).run();
    expect(written.map((card) => card.seq)).toEqual(["2"]);
    expect(metrics.value("search_card_failures_total")).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "search_card_failed", seq: "1" }),
    );
  });

  it("counts only the cards the store wrote: a listing changed meanwhile has its own", async () => {
    const { store } = memoryStore([listing("1", "Weather")], () => false);
    const lines: string[] = [];
    await rewrite(store, lines).run();
    expect(lines).toEqual([]);
  });

  it("logs and counts a failed read, and ends the rewrite", async () => {
    const store: SearchCardStore = {
      listings: async () => {
        throw new Error("database down");
      },
      write: async () => true,
    };
    const lines: string[] = [];
    const metrics = memoryMetrics();
    await rewrite(store, lines, metrics).run();
    expect(metrics.value("search_card_failures_total")).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ level: "error", event: "search_cards_read_failed", written: 0 }),
    );
  });

  it("stops between cards once closed, and close waits for the card under way", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let writing!: () => void;
    const underWay = new Promise<void>((resolve) => (writing = resolve));
    const written: string[] = [];
    const store: SearchCardStore = {
      listings: async (after) => (after === null ? [listing("1", "a"), listing("2", "b")] : []),
      write: async (l) => {
        writing();
        await held;
        written.push(l.seq);
        return true;
      },
    };
    const job = rewrite(store);
    job.start();
    await underWay;
    const closing = job.close();
    release();
    await closing;
    expect(written).toEqual(["1"]);
  });
});
