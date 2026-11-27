import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { Embedder, SearchCard, SearchCardStore } from "../ports/index.js";
import { unrefTimers, type Scheduler } from "../timers.js";

/** Cards read at a time, as the card rewrite reads listings. */
const PAGE = 100;

/** How often a run starts, as `rpc-stall.ts` polls. */
export const SEARCH_VECTORS_TICK_MS = 30_000;

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
  embedder: Embedder;
  /** True once the search model answers its health check, so it can embed. Never rejects. */
  ready: () => Promise<boolean>;
  logger: Logger;
  metrics: ProcessMetrics;
  schedule?: Scheduler;
}

export interface SearchVectors {
  /** A run now, then one every `SEARCH_VECTORS_TICK_MS` until `close()`; settles when the first ends. */
  start(): Promise<void>;
  /** No more runs; stops between cards and waits for the card under way. */
  close(): Promise<void>;
  /** `search_model_up`: 1 when the last run's health check answered, else 0; 0 before the first. */
  up(): 0 | 1;
}

/**
 * Each search card's vector (ADR 0014), written by one loop: a run at the start, then one every
 * 30 s. A run asks the model's health once, then embeds every card without a vector of its current
 * text, one at a time, so a backlog never takes the CPU queries need. A listing the catalog writes
 * gets its vector by the next run, and a model that is down ends the run, so the next one resumes
 * within 30 s of its return. A card the model fails on while it answers failed
 * on its own text: it is logged, counted and not tried again until its text changes or the
 * process restarts.
 */
export function createSearchVectors(deps: SearchVectorsDeps): SearchVectors {
  const { store, embedder, ready, logger, metrics } = deps;
  const schedule = deps.schedule ?? unrefTimers;
  let up: 0 | 1 = 0;
  let checked = false;
  let closed = false;
  let running: Promise<void> | undefined;
  let timer: unknown;
  // The text each failed card had, by seq: a card whose text is still the same is skipped.
  const failed = new Map<string, string>();

  const run = async () => {
    const answered = (await ready()) ? 1 : 0;
    // One line when the model stops answering, not one per tick while it stays down.
    if (answered === 0 && (up === 1 || !checked))
      logger.info("search_vectors_waiting_for_model", {});
    up = answered;
    checked = true;
    if (up === 0) return;
    let written = 0;
    let after = "0";
    while (!closed) {
      let page;
      try {
        page = await store.cards(after, PAGE);
      } catch (error) {
        logger.error("search_vectors_read_failed", { written, error });
        metrics.increment("search_vector_failures_total");
        return;
      }
      if (page.length === 0) break;
      for (const card of page) {
        if (closed) break;
        const text = meaningText(card);
        if (failed.get(card.seq) === text) continue;
        try {
          if (await store.writeVector(card, await embedder.embed(text, "listing"))) written++;
        } catch (error) {
          // A model that went away (a restart) fails every card alike: the next tick resumes.
          if (!(await ready())) {
            up = 0;
            logger.info("search_vectors_waiting_for_model", {});
            return;
          }
          failed.set(card.seq, text);
          logger.warn("search_vector_failed", { seq: card.seq, error });
          metrics.increment("search_vector_failures_total");
        }
      }
      after = page[page.length - 1]!.seq;
    }
    // A release's log shows whether every card got its vector.
    if (written > 0) logger.info("search_vectors_written", { written, stopped: closed });
  };

  // A tick that finds a run still under way skips, so runs never stack.
  const tick = () => {
    if (closed) return;
    timer = schedule.setTimeout(tick, SEARCH_VECTORS_TICK_MS);
    if (running) return;
    running = run().finally(() => (running = undefined));
  };

  return {
    start() {
      tick();
      return running ?? Promise.resolve();
    },
    async close() {
      closed = true;
      if (timer !== undefined) schedule.clearTimeout(timer);
      timer = undefined;
      await running;
    },
    up: () => up,
  };
}
