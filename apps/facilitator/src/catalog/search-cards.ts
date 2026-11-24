import { SEARCH_FIELDS_VERSION, searchFields } from "@stellar-x402/bazaar";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { SearchCardStore } from "../ports/index.js";

/** A pass every 5 s, of up to 500 listings: the seed's ~2,200 get their cards in about 25 s. */
const INTERVAL_MS = 5_000;
const BATCH = 500;

export interface SearchCardWriterDeps {
  store: SearchCardStore;
  logger: Logger;
  metrics: ProcessMetrics;
}

export interface SearchCardWriter {
  /** A pass every 5 s, ±10%, until `close()`; the timer keeps no process alive. */
  start(): void;
  /** One pass: writes the cards of up to 500 listings whose card is missing or of other rules. */
  runOnce(): Promise<void>;
  /** Stops the timer and waits for a pass under way, so the pools can end after it. */
  close(): Promise<void>;
}

/**
 * Carries the search cards (0120, ADR 0014) to this release's field rules, and writes the cards of
 * listings stored before cards existed; the catalog's write keeps each card in step with its
 * listing. Every process runs one: a card these rules already built is never written again. A
 * failure is logged and counted, and the next pass tries again.
 */
export function createSearchCardWriter(deps: SearchCardWriterDeps): SearchCardWriter {
  const { store, logger, metrics } = deps;
  let closed = false;

  const runOnce = async () => {
    let stale;
    try {
      stale = await store.stale(SEARCH_FIELDS_VERSION, BATCH);
    } catch (error) {
      logger.warn("search_cards_read_failed", { error });
      metrics.increment("search_card_failures_total");
      return;
    }
    let written = 0;
    // One card that fails is logged and skipped, so it never holds up the listings after it.
    for (const listing of stale) {
      // A shutdown waits for this pass, so it stops between cards.
      if (closed) break;
      try {
        const card = {
          seq: listing.seq,
          rules: SEARCH_FIELDS_VERSION,
          fields: searchFields(listing.resource),
        };
        if (await store.write(card)) written++;
      } catch (error) {
        logger.warn("search_card_failed", { seq: listing.seq, error });
        metrics.increment("search_card_failures_total");
      }
    }
    if (written > 0) logger.info("search_cards_written", { written });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(
      () => {
        running = runOnce().finally(() => {
          running = undefined;
          schedule();
        });
      },
      INTERVAL_MS * (0.9 + 0.2 * Math.random()),
    );
    timer.unref();
  };

  return {
    start: schedule,
    runOnce,
    async close() {
      closed = true;
      clearTimeout(timer);
      await running;
    },
  };
}
