import { describe, expect, it } from "vitest";
import type { BuildIssue } from "../src/adapters/emf.js";
import { emfMetrics } from "../src/adapters/emf-metrics.js";
import type { Scheduler } from "../src/timers.js";
import type { Labels } from "../src/metrics.js";

/** A wall-clock minute boundary. */
const T0 = 1_700_000_040_000;
const MIN = 60_000;
const TESTNET = "stellar:testnet" as const;
const PUBNET = "stellar:pubnet" as const;

type Line = Record<string, unknown> & { _aws: { Timestamp: number } };
const parse = (lines: string[]): Line[] => lines.map((l) => JSON.parse(l) as Line);
const linesFor = (name: string, lines: string[]) => parse(lines).filter((o) => name in o);
const stamps = (name: string, lines: string[]) =>
  linesFor(name, lines).map((o) => o._aws.Timestamp);

/** A fake clock and scheduler: timers run only when the test moves time. */
function fakeTime(start: number) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const schedule: Scheduler = {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const due = () => [...timers.entries()].sort(([a, x], [b, y]) => x.at - y.at || a - b).at(0);
  /** Runs every timer due up to `now + ms` in order, moving the clock to each one. */
  const advance = (ms: number) => {
    const end = t + ms;
    for (let next = due(); next && next[1].at <= end; next = due()) {
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
    }
    t = end;
  };
  /** A stall: the clock moves with no timer running, then the overdue ones fire late. */
  const jump = (ms: number) => {
    t += ms;
    advance(0);
  };
  /** The wall clock steps back (an NTP step); timers keep their delays, as real ones do. */
  const stepBack = (ms: number) => {
    t -= ms;
    for (const timer of timers.values()) timer.at -= ms;
  };
  return { now: () => t, schedule, advance, jump, stepBack, timers: () => timers.size };
}

type Opts = NonNullable<Parameters<typeof emfMetrics>[0]>;

function setup(opts: Partial<Opts> & { start?: number } = {}) {
  const time = fakeTime(opts.start ?? T0);
  const writes: string[] = [];
  const issues: BuildIssue[] = [];
  const m = emfMetrics({
    write: (l) => void writes.push(l),
    onIssue: (i) => void issues.push(i),
    now: time.now,
    schedule: time.schedule,
    ...opts,
  });
  return { m, writes, issues, time };
}

const OUTCOME: Labels = { result: "success", reason: "x", replay: false };
const SEEDS = [
  { name: "settlement_sweeps_total" as const, labels: { network: TESTNET, outcome: "listed" } },
  { name: "settlement_sweeps_total" as const, labels: { network: PUBNET, outcome: "listed" } },
];

describe("emfMetrics", () => {
  it("flushes at the next minute boundary with Timestamp = window start", () => {
    const { m, writes, time } = setup({ start: T0 + 30_000 });
    const net = m.for({ network: TESTNET });
    net.increment("settlement_outcomes_total", OUTCOME);
    time.advance(29_999);
    expect(writes).toHaveLength(0);
    time.advance(1);
    expect(stamps("settlement_outcomes_total", writes)).toEqual([T0]);
    // Re-aligned: the next window closes at the next boundary, not 60 s after a drifting start.
    net.increment("settlement_outcomes_total", OUTCOME);
    time.advance(MIN - 1);
    expect(writes).toHaveLength(1);
    time.advance(1);
    expect(stamps("settlement_outcomes_total", writes)).toEqual([T0, T0 + MIN]);
  });

  it("a 130 s clock jump writes the closed window once, no duplicate, no skipped write of pending data", () => {
    const { m, writes, time } = setup({ start: T0 + 5_000, seedZero: [SEEDS[0]!] });
    const net = m.for({ network: TESTNET });
    net.increment("settlement_outcomes_total", OUTCOME, 3);
    time.jump(130_000); // now T0 + 135 s, the T0 boundary timer fires late
    const outcomes = linesFor("settlement_outcomes_total", writes);
    expect(outcomes.map((o) => [o._aws.Timestamp, o.settlement_outcomes_total])).toEqual([[T0, 3]]);
    // The seed goes out with the closed window only: the skipped minute T0 + 1 min gets no line
    // at all, so the stall shows as missing data.
    expect(stamps("settlement_sweeps_total", writes)).toEqual([T0]);
    expect(parse(writes).filter((o) => o._aws.Timestamp === T0 + MIN)).toEqual([]);
    // An increment after the jump lands in the window it happened in.
    net.increment("settlement_outcomes_total", OUTCOME);
    time.advance(MIN);
    expect(stamps("settlement_outcomes_total", writes)).toEqual([T0, T0 + 2 * MIN]);
    expect(stamps("settlement_sweeps_total", writes)).toEqual([T0, T0 + 2 * MIN]);
    expect(parse(writes).filter((o) => o._aws.Timestamp === T0 + MIN)).toEqual([]);
    expect(linesFor("settlement_outcomes_total", writes).at(-1)!.settlement_outcomes_total).toBe(1);
  });

  it("eager-first: first increment written at once (value 1); second adds to the minute line with value 1", () => {
    const { m, writes, time } = setup({ start: T0 + 1_000 });
    const net = m.for({ network: TESTNET });
    net.increment("signer_failures_total");
    let got = linesFor("signer_failures_total", writes);
    expect(got.map((o) => [o._aws.Timestamp, o.signer_failures_total])).toEqual([[T0, 1]]);
    net.increment("signer_failures_total");
    expect(linesFor("signer_failures_total", writes)).toHaveLength(1);
    time.advance(MIN);
    got = linesFor("signer_failures_total", writes);
    expect(got.map((o) => [o._aws.Timestamp, o.signer_failures_total])).toEqual([
      [T0, 1],
      [T0, 1],
    ]);
    // A new window: the first increment is eager again. With by = 5 the window keeps 4.
    net.increment("signer_failures_total", {}, 5);
    expect(linesFor("signer_failures_total", writes).at(-1)!.signer_failures_total).toBe(1);
    time.advance(MIN);
    got = linesFor("signer_failures_total", writes).slice(2);
    expect(got.map((o) => [o._aws.Timestamp, o.signer_failures_total])).toEqual([
      [T0 + MIN, 1],
      [T0 + MIN, 4],
    ]);
  });

  it("eager-first single increment: no extra zero minute line", () => {
    const { m, writes, time } = setup();
    m.for({ network: TESTNET }).increment("settlement_record_failures_total");
    expect(writes).toHaveLength(1);
    time.advance(3 * MIN);
    expect(writes).toHaveLength(1);
  });

  it("aggregated counter: one minute line with the sum; next window starts at 0 (delta)", () => {
    const { m, writes, time } = setup();
    const net = m.for({ network: TESTNET });
    net.increment("settlement_outcomes_total", OUTCOME);
    net.increment("settlement_outcomes_total", OUTCOME, 2);
    expect(writes).toHaveLength(0);
    time.advance(MIN);
    const got = linesFor("settlement_outcomes_total", writes);
    expect(got.map((o) => o.settlement_outcomes_total)).toEqual([3]);
    time.advance(2 * MIN);
    expect(linesFor("settlement_outcomes_total", writes)).toHaveLength(1);
  });

  it("seedZero listed per network written every window, also after a reset", () => {
    const { m, writes, time } = setup({ seedZero: SEEDS });
    const window = (start: number) =>
      linesFor("settlement_sweeps_total", writes)
        .filter((o) => o._aws.Timestamp === start)
        .map((o) => [o.network, o.outcome, o.settlement_sweeps_total]);
    // The writer runs from construction: the zeros go out with no other use.
    time.advance(MIN);
    expect(window(T0)).toEqual([
      [TESTNET, "listed", 0],
      [PUBNET, "listed", 0],
    ]);
    m.for({ network: TESTNET }).increment("settlement_sweeps_total", { outcome: "listed" }, 2);
    time.advance(MIN);
    expect(window(T0 + MIN)).toEqual([
      [TESTNET, "listed", 2],
      [PUBNET, "listed", 0],
    ]);
    time.advance(MIN);
    expect(window(T0 + 2 * MIN)).toEqual([
      [TESTNET, "listed", 0],
      [PUBNET, "listed", 0],
    ]);
  });

  it("gauge sampled every 10 s -> Values array of 6 per minute; a throwing read skips that sample only", () => {
    const { m, writes, issues, time } = setup();
    let n = 0;
    m.for({ network: TESTNET }).registerGauge("pool_queued", () => {
      n += 1;
      if (n === 3) throw new Error("bad read");
      return { value: n };
    });
    m.for({ network: PUBNET }).registerGauge("pool_queued", () => ({ value: 7 }));
    time.advance(MIN);
    const got = linesFor("pool_queued", writes).map((o) => [o.network, o.pool_queued]);
    expect(got).toEqual([
      [TESTNET, [1, 2, 4, 5, 6]],
      [PUBNET, [7, 7, 7, 7, 7, 7]],
    ]);
    expect(issues).toEqual([{ kind: "read-failed", name: "pool_queued" }]);
    // Cleared after the flush: the next window has its own 6 samples.
    time.advance(MIN);
    const next = linesFor("pool_queued", writes).filter((o) => o._aws.Timestamp === T0 + MIN);
    expect(next.map((o) => o.pool_queued)).toEqual([
      [7, 8, 9, 10, 11, 12],
      [7, 7, 7, 7, 7, 7],
    ]);
  });

  it("a gauge's changing log field keeps its minute in one line, with the last sample's field", () => {
    const { m, writes, time } = setup();
    let n = 0;
    m.for({ network: TESTNET }).registerGauge("pool_queued", () => {
      n += 1;
      return { value: n, labels: { busy: n % 2, channels: 4 } };
    });
    time.advance(MIN);
    const got = linesFor("pool_queued", writes);
    expect(got.map((o) => [o.pool_queued, o.busy, o.channels])).toEqual([
      [[1, 2, 3, 4, 5, 6], 0, 4],
    ]);
  });

  it("keeps sampling after the wall clock steps back", () => {
    const { m, writes, time } = setup();
    m.for({ network: TESTNET }).registerGauge("pool_queued", () => ({ value: 1 }));
    time.advance(MIN);
    time.stepBack(60 * MIN);
    time.advance(2 * MIN);
    const after = linesFor("pool_queued", writes).filter((o) => o._aws.Timestamp < T0);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((o) => (o.pool_queued as number[]).length >= 5)).toBe(true);
  });

  it("raw values written as other make one line in the minute, each reported once", () => {
    const { m, writes, issues, time } = setup();
    const net = m.for({ network: TESTNET });
    for (let i = 0; i < 50; i++) net.increment("settlement_sweeps_total", { outcome: `bad-${i}` });
    time.advance(MIN);
    const got = linesFor("settlement_sweeps_total", writes);
    expect(got.map((o) => [o.outcome, o.settlement_sweeps_total])).toEqual([["other", 50]]);
    expect(issues.filter((i) => i.kind === "unknown-value")).toHaveLength(50);
  });

  it("samples capped at 100 per window", () => {
    const { m, writes, time } = setup({ sampleEveryMs: 100 });
    let n = 0;
    m.for({ network: TESTNET }).registerGauge("pool_queued", () => ({ value: n++ }));
    time.advance(MIN);
    const [line] = linesFor("pool_queued", writes);
    expect(line!.pool_queued).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("unknown value logged once per (kind,name,dim,value); cap holds", () => {
    const { m, issues, time } = setup();
    for (let i = 0; i < 3; i += 1) {
      m.increment("http_requests_total", { route: "/admin", status: 200 });
      time.advance(MIN);
    }
    expect(issues).toEqual([
      { kind: "unknown-value", name: "http_requests_total", dim: "route", value: "/admin" },
    ]);
    // A different value is another key. An aggregated counter's issues come at the window's close.
    m.increment("http_requests_total", { route: "/other", status: 200 });
    time.advance(MIN);
    expect(issues).toHaveLength(2);
    // An unknown name is reported at once, and never throws.
    expect(() => (m.increment as (n: string) => void)("nope_total")).not.toThrow();
    expect(issues.at(-1)).toEqual({ kind: "unknown-metric", name: "nope_total" });
    // At most 1000 keys are remembered; past that a new key is dropped, not logged.
    for (let i = 0; i < 1500; i += 1) m.increment("http_requests_total", { route: `/r${i}` });
    time.advance(MIN);
    expect(issues).toHaveLength(1000);
    m.increment("http_requests_total", { route: "/admin", status: 200 });
    m.increment("http_requests_total", { route: "/new" });
    time.advance(MIN);
    expect(issues).toHaveLength(1000);
  });

  it("flush awaits write promises; close() is idempotent and no write happens after it", async () => {
    const resolvers: (() => void)[] = [];
    const writes: string[] = [];
    const { m, time } = setup({
      write: (l) => {
        writes.push(l);
        return new Promise<void>((r) => resolvers.push(r));
      },
    });
    const net = m.for({ network: TESTNET });
    net.increment("signer_failures_total"); // eager: a pending write already
    net.increment("settlement_outcomes_total", OUTCOME);
    let flushed = false;
    const f = m.flush().then(() => (flushed = true));
    expect(writes).toHaveLength(2);
    await Promise.resolve();
    expect(flushed).toBe(false);
    for (const r of resolvers.splice(0)) r();
    await f;
    expect(flushed).toBe(true);
    // Idempotent per window: nothing new, nothing written.
    await m.flush();
    expect(writes).toHaveLength(2);

    // Bounded at 2 s: a write that never settles does not hang flush().
    net.increment("settlement_outcomes_total", OUTCOME);
    let bounded = false;
    const g = m.flush().then(() => (bounded = true));
    await Promise.resolve();
    expect(bounded).toBe(false);
    time.advance(1_999);
    await Promise.resolve();
    expect(bounded).toBe(false);
    time.advance(1);
    await g;
    expect(bounded).toBe(true);

    net.increment("settlement_outcomes_total", OUTCOME);
    const c1 = m.close();
    const c2 = m.close();
    for (const r of resolvers.splice(0)) r();
    await Promise.all([c1, c2]);
    await m.close();
    const count = writes.length;
    expect(linesFor("settlement_outcomes_total", writes).at(-1)!.settlement_outcomes_total).toBe(1);
    net.increment("settlement_outcomes_total", OUTCOME);
    net.increment("signer_failures_total");
    await m.flush();
    time.advance(5 * MIN);
    expect(writes).toHaveLength(count);
  });

  it("increment after close() does not restart timers", async () => {
    const { m, writes, time } = setup({ seedZero: SEEDS });
    expect(time.timers()).toBeGreaterThan(0);
    await m.close();
    expect(time.timers()).toBe(0);
    const count = writes.length;
    m.for({ network: TESTNET }).increment("settlement_outcomes_total", OUTCOME);
    m.increment("http_requests_total", { route: "/verify", status: 200 });
    m.for({ network: TESTNET }).registerGauge("pool_queued", () => ({ value: 1 }));
    expect(time.timers()).toBe(0);
    time.advance(5 * MIN);
    expect(writes).toHaveLength(count);
  });

  it("a throwing write never propagates", async () => {
    for (const write of [
      () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("boom")),
    ]) {
      const { m, time } = setup({
        write,
        seedZero: SEEDS,
        onIssue: () => {
          throw new Error("onIssue boom");
        },
      });
      const net = m.for({ network: TESTNET });
      net.registerGauge("pool_queued", () => ({ value: 1 }));
      expect(() => net.increment("signer_failures_total")).not.toThrow();
      expect(() => net.increment("settlement_outcomes_total", OUTCOME)).not.toThrow();
      // @ts-expect-error -- the root takes only process-scoped names; at run time it still drops it.
      expect(() => m.increment("settlement_outcomes_total", OUTCOME)).not.toThrow();
      expect(() => time.advance(2 * MIN)).not.toThrow();
      await expect(m.flush()).resolves.toBeUndefined();
      await expect(m.close()).resolves.toBeUndefined();
    }
  });

  it("a non-finite or negative by is ignored; labels are copied on store", () => {
    const { m, writes, time } = setup();
    const net = m.for({ network: TESTNET });
    for (const by of [NaN, Infinity, -1]) {
      net.increment("settlement_outcomes_total", OUTCOME, by);
      net.increment("signer_failures_total", {}, by);
    }
    expect(writes).toHaveLength(0);
    // The root passes the caller's object on as is; the stored series must not follow it.
    const labels: Labels = { route: "/verify", status: 200 };
    m.increment("http_requests_total", labels);
    labels.route = "/settle";
    time.advance(MIN);
    expect(linesFor("http_requests_total", writes).map((o) => o.route)).toEqual(["/verify"]);
  });

  it("each for() child writes over the same state", () => {
    const { m, writes, issues, time } = setup();
    m.for({ network: TESTNET }).increment("settlement_outcomes_total", OUTCOME);
    m.for({ network: TESTNET }).increment("settlement_outcomes_total", OUTCOME);
    time.advance(MIN);
    const got = linesFor("settlement_outcomes_total", writes);
    expect(got.map((o) => [o.network, o.settlement_outcomes_total])).toEqual([[TESTNET, 2]]);
    expect(issues).toEqual([]);
  });

  it("a network-scoped name on the root doesn't compile, and at run time writes no line", () => {
    const { m, writes, issues, time } = setup();
    // @ts-expect-error -- the root takes only process-scoped names (0027 AD-3).
    m.increment("settlement_outcomes_total", OUTCOME);
    time.advance(MIN);
    expect(linesFor("settlement_outcomes_total", writes)).toEqual([]);
    expect(issues).toEqual([{ kind: "no-valid-set", name: "settlement_outcomes_total" }]);
  });
});
