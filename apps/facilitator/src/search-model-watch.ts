import { unrefTimers, type Scheduler } from "./timers.js";

/** How often the facilitator asks the search model for its health, as `rpc-stall.ts` polls. */
export const SEARCH_MODEL_POLL_MS = 30_000;

export interface SearchModelWatch {
  /** Checks now, then every `SEARCH_MODEL_POLL_MS` until `stop()`. A second call does nothing. */
  start(): void;
  /** Ends the checks; one still under way lands unrecorded. */
  stop(): void;
  /** 1 when the last health check answered, else 0; 0 before the first answer. */
  up(): 0 | 1;
}

/**
 * `search_model_up` (ADR 0014): the search model's health, checked on a timer whether anyone
 * searches or not. A model that is down shows otherwise only through searches and catalog writes,
 * so with no traffic a model in a restart loop would send nothing. A tick that finds a check still
 * under way is skipped, so checks never stack. `ready` never rejects.
 */
export function createSearchModelWatch(deps: {
  ready: () => Promise<boolean>;
  schedule?: Scheduler;
}): SearchModelWatch {
  const schedule = deps.schedule ?? unrefTimers;
  let up: 0 | 1 = 0;
  let checking = false;
  let running = false;
  let timer: unknown;

  function tick() {
    if (!running) return;
    timer = schedule.setTimeout(tick, SEARCH_MODEL_POLL_MS);
    if (checking) return;
    checking = true;
    void deps
      .ready()
      .then((answered) => {
        if (running) up = answered ? 1 : 0;
      })
      .finally(() => {
        checking = false;
      });
  }

  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      if (timer !== undefined) schedule.clearTimeout(timer);
      timer = undefined;
    },
    up: () => up,
  };
}
