import { searchFields } from "@stellar-x402/bazaar";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { SearchCardStore } from "../ports/index.js";

/** Listings read at a time: at ADR 0008's 36 KiB a listing, at most about 18 MiB of listing text. */
const PAGE = 500;

export interface SearchCardRewriteDeps {
  store: SearchCardStore;
  logger: Logger;
  metrics: ProcessMetrics;
}

export interface SearchCardRewrite {
  /** Starts the rewrite in the background, the process serving meanwhile; settles when it ends. */
  start(): Promise<void>;
  /** Rewrites every listing's card, page by page, and resolves when done. */
  run(): Promise<void>;
  /** Stops between cards and waits for the card under way, so the pools can end after it. */
  close(): Promise<void>;
}

/**
 * Rewrites every catalog listing's search card (0120, ADR 0014) once, as the release starts, with
 * this release's field rules: so the cards of listings stored before cards existed, written by
 * other rules, or left behind by a rolled-back release all match their listings. Between starts
 * the catalog's write keeps each card in step. A failure is logged and counted; a failed read ends
 * the rewrite until the next start.
 */
export function createSearchCardRewrite(deps: SearchCardRewriteDeps): SearchCardRewrite {
  const { store, logger, metrics } = deps;
  let closed = false;
  let running: Promise<void> | undefined;

  const run = async () => {
    let written = 0;
    let after: string | null = null;
    while (!closed) {
      let page;
      try {
        page = await store.listings(after, PAGE);
      } catch (error) {
        logger.warn("search_cards_read_failed", { error });
        metrics.increment("search_card_failures_total");
        return;
      }
      if (page.length === 0) break;
      // One card that fails is logged and skipped, so it never holds up the listings after it.
      for (const listing of page) {
        // A shutdown waits for the rewrite, so it stops between cards.
        if (closed) break;
        try {
          if (await store.write(listing, searchFields(listing.resource))) written++;
        } catch (error) {
          logger.warn("search_card_failed", { seq: listing.seq, error });
          metrics.increment("search_card_failures_total");
        }
      }
      after = page[page.length - 1]!.seq;
    }
    if (written > 0) logger.info("search_cards_written", { written });
  };

  return {
    start() {
      running = run();
      return running;
    },
    run,
    async close() {
      closed = true;
      await running;
    },
  };
}
