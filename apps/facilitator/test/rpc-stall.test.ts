import { describe, expect, test } from "vitest";
import type { Scheduler } from "../src/timers.js";
import { createRpcStallTracker } from "../src/rpc-stall.js";

// `rpc_stalled_seconds` (0027 AD-5): the time since the ledger sequence last changed, read at the
// gauge's read, so a dead poller or endpoint shows as a rising value.

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
  /** Fires every timer due now, as the next tick would. */
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  return { schedule, tick, ms, pending: () => timers.size };
}

/** The shared client as the tracker reads it: its active endpoint's name and the latest ledger. */
function fakeRpc() {
  const rpc = {
    active: "rpc-0",
    sequence: 100,
    fail: false,
    reads: 0,
    /** While set, each read waits for it. */
    held: undefined as Promise<void> | undefined,
    async getLatestLedger() {
      rpc.reads++;
      if (rpc.held) await rpc.held;
      if (rpc.fail) throw new Error("fetch failed");
      return { sequence: rpc.sequence };
    },
  };
  return rpc;
}

/** Lets every settled read's continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(start = 0) {
  const clock = { now: start };
  const rpc = fakeRpc();
  const timers = fakeScheduler();
  const tracker = createRpcStallTracker({
    rpc,
    now: () => clock.now,
    schedule: timers.schedule,
  });
  /** Moves the clock on by `ms`, fires the tick and lets its read land. */
  const step = async (ms = 30_000) => {
    clock.now += ms;
    timers.tick();
    await settle();
  };
  return { clock, rpc, timers, tracker, step };
}

describe("createRpcStallTracker", () => {
  test("age rises from the last sequence change; a new sequence resets it", async () => {
    const { clock, rpc, timers, tracker, step } = setup();
    tracker.start();
    await settle();
    expect(rpc.reads).toBe(1);
    expect(tracker.stalledSeconds()).toBe(0);
    // Every 30 s by default.
    expect(timers.ms).toEqual([30_000]);

    await step();
    expect(tracker.stalledSeconds()).toBe(30);
    await step();
    expect(tracker.stalledSeconds()).toBe(60);
    // Read at the gauge's read, between ticks too.
    clock.now += 5_000;
    expect(tracker.stalledSeconds()).toBe(65);

    rpc.sequence = 101;
    await step(25_000);
    expect(rpc.reads).toBe(4);
    expect(tracker.stalledSeconds()).toBe(0);
    clock.now += 10_000;
    expect(tracker.stalledSeconds()).toBe(10);
    tracker.stop();
  });

  test("active endpoint change resets the baseline; a sequence drop resets it", async () => {
    const { rpc, tracker, step } = setup();
    tracker.start();
    await settle();
    await step();
    await step();
    expect(tracker.stalledSeconds()).toBe(60);

    // A failover to an endpoint at the same sequence: a new baseline, not a stall carried over.
    rpc.active = "rpc-1";
    await step();
    expect(tracker.stalledSeconds()).toBe(0);
    await step();
    expect(tracker.stalledSeconds()).toBe(30);

    // A lagging fallback, or testnet's reset: the sequence drops, and counts from there.
    rpc.sequence = 50;
    await step();
    expect(tracker.stalledSeconds()).toBe(0);
    await step();
    expect(tracker.stalledSeconds()).toBe(30);
    rpc.sequence = 51;
    await step();
    expect(tracker.stalledSeconds()).toBe(0);
    tracker.stop();
  });

  test("failed reads leave the age rising", async () => {
    // Created at 1 000, started at 5 000: before a good read the age counts from start().
    const { clock, rpc, tracker, step } = setup(1_000);
    rpc.fail = true;
    clock.now = 5_000;
    tracker.start();
    await settle();
    expect(tracker.stalledSeconds()).toBe(0);
    await step();
    expect(tracker.stalledSeconds()).toBe(30);
    await step();
    expect(tracker.stalledSeconds()).toBe(60);

    rpc.fail = false;
    await step();
    expect(tracker.stalledSeconds()).toBe(0);

    // After a good read, failures keep the age rising from the last change.
    rpc.fail = true;
    rpc.sequence = 999;
    await step();
    await step();
    expect(tracker.stalledSeconds()).toBe(60);
    tracker.stop();
  });

  test("a read still pending skips the next tick, so reads never stack", async () => {
    const { rpc, timers, tracker, step } = setup();
    let release!: () => void;
    rpc.held = new Promise((resolve) => (release = resolve));
    tracker.start();
    await settle();
    expect(rpc.reads).toBe(1);
    await step();
    await step();
    // Still one read in flight, and the ticks keep coming.
    expect(rpc.reads).toBe(1);
    expect(timers.pending()).toBe(1);
    expect(tracker.stalledSeconds()).toBe(60);

    rpc.held = undefined;
    release();
    await settle();
    // The read that landed is the first good one: the baseline starts at its landing.
    expect(tracker.stalledSeconds()).toBe(0);
    await step();
    expect(rpc.reads).toBe(2);
    tracker.stop();
  });

  test("stop() ends the ticks; a read landing after it changes nothing", async () => {
    const { clock, rpc, timers, tracker, step } = setup();
    tracker.start();
    await settle();
    await step();
    expect(tracker.stalledSeconds()).toBe(30);

    let release!: () => void;
    rpc.held = new Promise((resolve) => (release = resolve));
    rpc.sequence = 101;
    await step();
    tracker.stop();
    expect(timers.pending()).toBe(0);
    rpc.held = undefined;
    release();
    await settle();
    expect(tracker.stalledSeconds()).toBe(60);

    clock.now += 60_000;
    timers.tick();
    await settle();
    expect(rpc.reads).toBe(3);
  });
});
