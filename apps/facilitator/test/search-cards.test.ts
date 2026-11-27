import { describe, expect, it } from "vitest";
import { createSearchCardRewrite } from "../src/catalog/search-cards.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { CardListing, SearchCardStore } from "../src/ports/index.js";

/** What the card rewrite reads and writes. */
type CardRewriteStore = Pick<SearchCardStore, "listings" | "write">;

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
  const written: string[] = [];
  const store: CardRewriteStore = {
    listings: async (after, limit) =>
      listings.filter((l) => Number(l.seq) > Number(after)).slice(0, limit),
    write: async (l) => {
      if (write && !write(l.seq)) return false;
      written.push(l.seq);
      return true;
    },
  };
  return { store, written };
}

const rewrite = (store: CardRewriteStore, lines: string[] = [], metrics = memoryMetrics()) =>
  createSearchCardRewrite({
    store,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
  });

describe("search card rewrite", () => {
  it("rewrites every listing's card, past one page, and logs the end", async () => {
    const all = Array.from({ length: 501 }, (_, i) => listing(String(i + 1), `d${i + 1}`));
    const { store, written } = memoryStore(all);
    const lines: string[] = [];
    await rewrite(store, lines).start();
    expect(written).toHaveLength(501);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "search_cards_written", written: 501, stopped: false }),
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
    await rewrite(store, lines, metrics).start();
    expect(written).toEqual(["2"]);
    expect(metrics.value("search_card_failures_total")).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "search_card_failed", seq: "1" }),
    );
  });

  it("counts only the cards the store wrote: a listing changed meanwhile has its own", async () => {
    const { store } = memoryStore([listing("1", "Weather")], () => false);
    const lines: string[] = [];
    await rewrite(store, lines).start();
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "search_cards_written", written: 0 }),
    );
  });

  it("logs and counts a failed read, and ends the rewrite", async () => {
    const store: CardRewriteStore = {
      listings: async () => {
        throw new Error("database down");
      },
      write: async () => true,
    };
    const lines: string[] = [];
    const metrics = memoryMetrics();
    await rewrite(store, lines, metrics).start();
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
    const store: CardRewriteStore = {
      listings: async (after) => (after === "0" ? [listing("1", "a"), listing("2", "b")] : []),
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
