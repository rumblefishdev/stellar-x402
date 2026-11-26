import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { CatalogKey, Embedder, SearchCard, SearchCardStore } from "../ports/index.js";

/** Cards read at a time, as the card rewrite reads listings. */
const PAGE = 100;

/**
 * The text a card's vector is made from: its fields joined with a line break, empty ones left
 * out. The search model reads its first 2,000 characters (ADR 0014).
 */
export function meaningText(card: SearchCard): string {
  return [card.name, card.tags, card.description, card.parameters]
    .filter((field) => field !== "")
    .join("\n");
}

export interface SearchVectorsDeps {
  store: SearchCardStore;
  /** The model the search model container runs (`SEARCH_MODEL_ID`): a vector of another is redone. */
  model: string;
  embedder: Embedder;
  /** True once the search model answers its health check, so it can embed. */
  ready: () => Promise<boolean>;
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
 * it wrote; once per start, after the card rewrite, a pass embeds every card without a vector of
 * `model` of its current text: the database keeps each card's text hash, and a vector counts only
 * while the hash it was made from equals it. A listing the model fails on is logged and counted,
 * and waits for the next start.
 */
export function createSearchVectors(deps: SearchVectorsDeps): SearchVectors {
  const { store, model, embedder, ready, logger, metrics } = deps;
  let closed = false;
  let running: Promise<void> | undefined;
  // Ends the wait for the model at once on close, timers faked or not.
  let wake = () => {};
  // The model's queue: the pass and every catalog write wait their turn, so the model embeds one
  // listing at a time and a query's vector waits behind one listing at most.
  let turn: Promise<unknown> = Promise.resolve();
  const embed = (text: string) => {
    const answer = turn.then(() => embedder.embed(text, "listing"));
    // The next one waits for this one to end, failed or not; its caller still gets the failure.
    turn = answer.catch(() => {});
    return answer;
  };

  const run = async () => {
    // The model loads for about 12 s after its container starts, and the facilitator doesn't wait
    // for it, so `/settle` doesn't either: the pass does, or every card would fail until the next
    // start.
    let waiting = false;
    while (!closed && !(await ready())) {
      if (!waiting) logger.info("search_vectors_waiting_for_model", {});
      waiting = true;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 1_000);
      });
    }
    let written = 0;
    let after = "0";
    while (!closed) {
      let page;
      try {
        page = await store.cards(after, PAGE, model);
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
        try {
          if (await store.writeVector(card, await embed(meaningText(card)))) written++;
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
      wake();
      await running;
    },
    async listed(key) {
      try {
        const card = await store.card(key);
        if (card === undefined)
          throw new Error("the catalog holds no card for the listing written");
        // A write that left the card's text as it was kept its vector.
        if (card.model === model) return;
        await store.writeVector(card, await embed(meaningText(card)));
      } catch (error) {
        logger.warn("search_vector_failed", { resourceUrl: key.resourceUrl, error });
        metrics.increment("search_vector_failures_total");
      }
    },
  };
}
