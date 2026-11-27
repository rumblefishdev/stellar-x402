import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { SearchCardStore } from "../ports/index.js";

/**
 * Listings read at a time, the discovery route's largest page: a seller's example values can make
 * a 36 KiB listing (ADR 0008) take about 0.66 MiB once parsed, so 100 hold about 66 MiB, well
 * inside the process's memory (measured on Node 22 with an `info.input.body` of empty objects).
 */
const PAGE = 100;

export interface SearchCardRewriteDeps {
  store: Pick<SearchCardStore, "listings" | "write">;
  logger: Logger;
  metrics: ProcessMetrics;
}

export interface SearchCardRewrite {
  /** Starts the rewrite in the background, the process serving meanwhile; settles when it ends. */
  start(): Promise<void>;
  /** Stops between cards and waits for the card under way, so the pools can end after it. */
  close(): Promise<void>;
}

/**
 * Rewrites every catalog listing's search card (0120, ADR 0014) once, as the release starts, with
 * this release's field rules: so the cards of listings stored before cards existed, written by
 * other rules, or left behind by a rolled-back release all match their listings. Between starts
 * the catalog's write keeps each card in step. A failure is logged and counted; a failed read ends
 * the rewrite until the next start, logged as an error with the count of cards written.
 */
export function createSearchCardRewrite(deps: SearchCardRewriteDeps): SearchCardRewrite {
  const { store, logger, metrics } = deps;
  let closed = false;
  let running: Promise<void> | undefined;

  const run = async () => {
    let written = 0;
    let after = "0";
    while (!closed) {
      let page;
      try {
        page = await store.listings(after, PAGE);
      } catch (error) {
        // Nothing tries again before the next start, so the cards past this page stay as they are.
        logger.error("search_cards_read_failed", { written, error });
        metrics.increment("search_card_failures_total");
        return;
      }
      if (page.length === 0) break;
      // One card that fails is logged and skipped, so it never holds up the listings after it.
      for (const listing of page) {
        // A shutdown waits for the rewrite, so it stops between cards.
        if (closed) break;
        try {
          if (await store.write(listing)) written++;
        } catch (error) {
          logger.warn("search_card_failed", { seq: listing.seq, error });
          metrics.increment("search_card_failures_total");
        }
      }
      after = page[page.length - 1]!.seq;
    }
    // One line at the end, so a release's log shows whether every card has its rules.
    logger.info("search_cards_written", { written, stopped: closed });
  };

  return {
    start() {
      running = run();
      return running;
    },
    async close() {
      closed = true;
      await running;
    },
  };
}
