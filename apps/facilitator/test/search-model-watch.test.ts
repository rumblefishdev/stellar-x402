import { describe, expect, test } from "vitest";
import { createSearchModelWatch, SEARCH_MODEL_POLL_MS } from "../src/search-model-watch.js";
import type { Scheduler } from "../src/timers.js";

// `search_model_up` (ADR 0014): the search model's health, checked on a timer whether anyone
// searches or not, so a model that is down with no traffic still shows.

/** Timers that fire only when the test says so; `ms` records each delay asked for. */
function fakeScheduler() {
  const timers = new Map<number, () => void>();
  const ms: number[] = [];
  let next = 0;
  const schedule: Scheduler = {
    setTimeout(fn, delay) {
      ms.push(delay);
      timers.set(++next, fn);
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  return { schedule, tick, ms, pending: () => timers.size };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("search model watch", () => {
  test("is 0 until the first answer, then follows each health check every 30 s", async () => {
    const { schedule, tick, ms } = fakeScheduler();
    let healthy = true;
    const watch = createSearchModelWatch({ ready: async () => healthy, schedule });
    expect(watch.up()).toBe(0);
    watch.start();
    await settled();
    expect(watch.up()).toBe(1);
    expect(ms).toEqual([SEARCH_MODEL_POLL_MS]);
    expect(SEARCH_MODEL_POLL_MS).toBe(30_000);
    healthy = false;
    tick();
    await settled();
    expect(watch.up()).toBe(0);
    healthy = true;
    tick();
    await settled();
    expect(watch.up()).toBe(1);
  });

  test("never stacks checks: a tick while one is under way asks nothing", async () => {
    const { schedule, tick } = fakeScheduler();
    let asked = 0;
    let answer!: (up: boolean) => void;
    const watch = createSearchModelWatch({
      ready: () => {
        asked++;
        return new Promise<boolean>((resolve) => (answer = resolve));
      },
      schedule,
    });
    watch.start();
    tick();
    expect(asked).toBe(1);
    answer(true);
    await settled();
    expect(watch.up()).toBe(1);
  });

  test("stops checking once stopped", async () => {
    const { schedule, tick, pending } = fakeScheduler();
    let asked = 0;
    const watch = createSearchModelWatch({
      ready: async () => {
        asked++;
        return true;
      },
      schedule,
    });
    watch.start();
    watch.stop();
    tick();
    await settled();
    expect(asked).toBe(1);
    expect(pending()).toBe(0);
  });
});
