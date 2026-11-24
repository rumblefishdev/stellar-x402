import { createHash } from "node:crypto";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { CatalogKey, Embedder, SearchCard, SearchVectorStore } from "../ports/index.js";

/** Cards read at a time, as the card rewrite reads listings. */
const PAGE = 100;
/** ADR 0014: the meaning part reads the card's fields joined, cut at 2,000 characters. */
const MAX_TEXT_CHARS = 2_000;

/**
 * The text a card's vector is made from: its fields joined with a line break, empty ones left
 * out, cut at 2,000 characters counted as code points, as the search model cuts it, so a cut never
 * splits one.
 */
export function meaningText(card: SearchCard): string {
  const joined = [card.name, card.tags, card.description, card.parameters]
    .filter((field) => field !== "")
    .join("\n");
  return Array.from(joined).slice(0, MAX_TEXT_CHARS).join("");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface SearchVectorsDeps {
  store: SearchVectorStore;
  embedder: Embedder;
  logger: Logger;
  metrics: ProcessMetrics;
}

export interface SearchVectors {
  /** Starts the pass in the background, the process serving meanwhile; settles when it ends. */
  start(): Promise<void>;
  /** Stops between cards and waits for the card under way, so the pools can end after it. */
  close(): Promise<void>;
  /**
   * Computes and stores the vector of the listing at `key`, which the catalog has just written.
   * Never rejects: a failure is logged and counted, and the next start's pass tries again.
   */
  listed(key: CatalogKey): Promise<void>;
}

/**
 * Each search card's vector (ADR 0014), asked of the search model one listing at a time, so a
 * backlog never takes the CPU queries need. The catalog's write asks for the vector of the listing
 * it wrote; once per start, after the card rewrite, a pass embeds every card whose vector is
 * missing or stale: made by another model, or from another text. The pass knows the model once
 * the first answer names it, so until then a card with a vector is embedded again. A listing the
 * model fails on is logged and counted, and waits for the next start.
 */
export function createSearchVectors(deps: SearchVectorsDeps): SearchVectors {
  const { store, embedder, logger, metrics } = deps;
  let closed = false;
  let running: Promise<void> | undefined;

  const run = async () => {
    let written = 0;
    let model: string | undefined;
    let after = "0";
    while (!closed) {
      let page;
      try {
        page = await store.cards(after, PAGE);
      } catch (error) {
        // Nothing tries again before the next start, so the cards past this page wait for it.
        logger.error("search_vectors_read_failed", { written, error });
        metrics.increment("search_vector_failures_total");
        return;
      }
      if (page.length === 0) break;
      for (const card of page) {
        // A shutdown waits for the pass, so it stops between cards.
        if (closed) break;
        const text = meaningText(card);
        const textHash = sha256(text);
        if (card.model === model && card.textHash === textHash) continue;
        try {
          const embedding = await embedder.embed(text);
          model = embedding.model;
          if (await store.writeVector(card, embedding, textHash)) written++;
        } catch (error) {
          logger.warn("search_vector_failed", { seq: card.seq, error });
          metrics.increment("search_vector_failures_total");
        }
      }
      after = page[page.length - 1]!.seq;
    }
    // One line at the end, so a release's log shows whether every card has its vector.
    logger.info("search_vectors_written", { written, stopped: closed });
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
    async listed(key) {
      try {
        const card = await store.card(key);
        if (card === undefined)
          throw new Error("the catalog holds no card for the listing written");
        const text = meaningText(card);
        await store.writeVector(card, await embedder.embed(text), sha256(text));
      } catch (error) {
        logger.warn("search_vector_failed", { resourceUrl: key.resourceUrl, error });
        metrics.increment("search_vector_failures_total");
      }
    },
  };
}
