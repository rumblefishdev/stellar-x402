// Stateful EMF adapter (lore 0027 notes/S-pr112-spine.md, AD-4): a wall-clock minute window of
// counter deltas and gauge samples, eager-first event counters, zero seeds, and an awaited flush.
// The pure line builder lives in ./emf.ts; this file owns all state, the timers and the I/O.
import { byName, eagerNames, effectiveSets, type CounterName } from "@stellar-x402/metrics-catalog";
import {
  scoped,
  seriesKey as keyOf,
  type GaugeRead,
  type Labels,
  type MetricsWriter,
  type ProcessMetrics,
} from "../metrics.js";
import { unrefTimers, type Scheduler } from "../timers.js";
import {
  MAX_VALUES as MAX_SAMPLES,
  buildEvent,
  buildTick,
  dimValue,
  type BuildIssue,
  type Reading,
} from "./emf.js";

const MINUTE_MS = 60_000;
const SAMPLE_EVERY_MS = 10_000;
/** How long `flush()` waits for the writes to settle. */
const FLUSH_BOUND_MS = 2_000;
/** Distinct issues remembered; a new one past the cap is dropped, so a flood stays bounded. */
const MAX_ISSUE_KEYS = 1_000;

const stdoutWrite = (line: string): Promise<void> =>
  new Promise<void>((resolve) => {
    process.stdout.write(line + "\n", () => resolve());
  });

type Series = { name: string; labels: Labels; sum: number; seed: boolean };
type Samples = { name: string; labels: Labels; values: number[] };

const minuteOf = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;

/**
 * A counter's key: a closed dimension's value outside its list is keyed as `other`, the value it
 * is written as, so raw values that all write `other` make one line in the minute, not one each.
 * Each such value comes back as an issue, since the merged line carries only the first one's.
 */
const counterKeyOf = (name: string, labels: Labels): { key: string; issues: BuildIssue[] } => {
  const def = byName(name);
  if (!def?.values) return { key: keyOf(name, labels), issues: [] };
  const keyed: Labels = { ...labels };
  const issues: BuildIssue[] = [];
  for (const dim of Object.keys(def.values)) {
    const written = dimValue(def, dim, keyed[dim]);
    if (written?.unknown === undefined) continue;
    keyed[dim] = written.value;
    issues.push({ kind: "unknown-value", name, dim, value: written.unknown });
  }
  return { key: keyOf(name, keyed), issues };
};

/**
 * A gauge's series: its name and the labels that are dimensions. A log field such as
 * `pool_queued`'s `busy` changes between samples; keyed on it, one minute's samples would split
 * across lines, so the line keeps the last sample's log fields instead.
 */
const gaugeKeyOf = (name: string, labels: Labels) => {
  const def = byName(name);
  if (!def) return keyOf(name, labels);
  const dims = new Set(effectiveSets(def).flatMap((set) => set.dims));
  return keyOf(name, Object.fromEntries(Object.entries(labels).filter(([k]) => dims.has(k))));
};

export function emfMetrics(
  opts: {
    write?: (line: string) => void | Promise<void>;
    now?: () => number;
    /**
     * Counters written as 0 in every window, `network` included in their labels: the liveness
     * points a Silence alarm reads. They start the timers at construction.
     */
    seedZero?: ReadonlyArray<{ name: CounterName; labels: Labels }>;
    /** Each distinct issue once (per kind, name, dim and value), at most 1000 of them. */
    onIssue?: (issue: BuildIssue) => void;
    sampleEveryMs?: number;
    schedule?: Scheduler;
  } = {},
): ProcessMetrics & { flush(): Promise<void>; close(): Promise<void> } {
  const write = opts.write ?? stdoutWrite;
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? unrefTimers;
  const sampleEvery =
    typeof opts.sampleEveryMs === "number" &&
    Number.isFinite(opts.sampleEveryMs) &&
    opts.sampleEveryMs > 0
      ? opts.sampleEveryMs
      : SAMPLE_EVERY_MS;
  const seeds = (opts.seedZero ?? []).map((s) => ({ name: s.name, labels: { ...s.labels } }));

  // ---- state of the open window ----
  let windowStart = minuteOf(now());
  const counters = new Map<string, Series>();
  const samples = new Map<string, Samples>();
  /** Eager-first series whose first increment of this window is already out. */
  const eagerSent = new Set<string>();

  const gauges: { name: string; read: GaugeRead }[] = [];
  const pending = new Set<Promise<void>>();
  const issueKeys = new Set<string>();
  let timer: unknown;
  let nextSampleAt = Math.ceil(now() / sampleEvery) * sampleEvery;
  let stopped = false;
  let closing: Promise<void> | undefined;

  function report(issues: readonly BuildIssue[]): void {
    for (const issue of issues) {
      const key = JSON.stringify([issue.kind, issue.name, issue.dim ?? null, issue.value ?? null]);
      if (issueKeys.has(key) || issueKeys.size >= MAX_ISSUE_KEYS) continue;
      issueKeys.add(key);
      try {
        opts.onIssue?.(issue);
      } catch {
        /* a failing logger must not stop the writer */
      }
    }
  }

  function emit(line: string): void {
    try {
      const r = write(line);
      if (r && typeof (r as Promise<void>).then === "function") {
        const p: Promise<void> = Promise.resolve(r).then(
          () => undefined,
          () => undefined,
        );
        pending.add(p);
        void p.then(() => pending.delete(p));
      }
    } catch {
      /* emission never throws */
    }
  }

  function writeTick(snapshot: { counters: Reading[]; gauges: Reading[] }, ts: number): void {
    if (snapshot.counters.length === 0 && snapshot.gauges.length === 0) return;
    const { lines, issues } = buildTick(snapshot, ts);
    report(issues);
    for (const line of lines) emit(line);
  }

  function applySeeds(): void {
    for (const { name, labels } of seeds) {
      const key = keyOf(name, labels);
      const series = counters.get(key);
      if (series) series.seed = true;
      else counters.set(key, { name, labels, sum: 0, seed: true });
    }
  }

  /** Writes what the open window holds, stamped with its start, and empties it. */
  function drain(): void {
    const snapshot = {
      counters: [...counters.values()]
        .filter((s) => s.sum > 0 || s.seed)
        .map((s) => ({ name: s.name, value: s.sum, labels: s.labels })),
      gauges: [...samples.values()].map((s) => ({
        name: s.name,
        value: s.values,
        labels: s.labels,
      })),
    };
    counters.clear();
    samples.clear();
    writeTick(snapshot, windowStart);
  }

  /**
   * Moves the window to the minute of `t`. The closed window is written once with its own start;
   * a minute skipped by a stall gets nothing, not even the seeds, so the stall shows as missing
   * data (the `facilitator-silent` Silence alarm) instead of zeros written after the fact.
   */
  function roll(t: number): void {
    const minute = minuteOf(t);
    if (minute === windowStart) return;
    drain();
    windowStart = minute;
    eagerSent.clear();
    applySeeds();
  }

  function sample(): void {
    for (const { name, read } of gauges) {
      let value: unknown;
      let labels: Labels;
      try {
        const r = read();
        value = typeof r.value === "bigint" ? Number(r.value) : r.value;
        labels = { ...r.labels };
      } catch {
        report([{ kind: "read-failed", name }]);
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        report([{ kind: "non-finite", name }]);
        continue;
      }
      const key = gaugeKeyOf(name, labels);
      const series = samples.get(key);
      if (!series) samples.set(key, { name, labels, values: [value] });
      else {
        series.labels = labels;
        if (series.values.length < MAX_SAMPLES) series.values.push(value);
      }
    }
  }

  // One timer chain: the next sample slot or the next minute boundary, whichever is first,
  // recomputed from the clock each time so it never drifts.
  function tick(): void {
    timer = undefined;
    if (stopped) return;
    try {
      const t = now();
      roll(t);
      // A wall clock stepped back leaves the next slot far ahead: sample now and re-align.
      if (t >= nextSampleAt || nextSampleAt - t > sampleEvery) {
        sample();
        nextSampleAt = (Math.floor(t / sampleEvery) + 1) * sampleEvery;
      }
    } catch {
      /* never throws */
    }
    arm();
  }

  function arm(): void {
    if (stopped || timer !== undefined) return;
    try {
      const due = Math.min(windowStart + MINUTE_MS, nextSampleAt);
      timer = schedule.setTimeout(tick, Math.max(0, due - now()));
    } catch {
      timer = undefined;
    }
  }

  function disarm(): void {
    if (timer === undefined) return;
    try {
      schedule.clearTimeout(timer);
    } catch {
      /* never throws */
    }
    timer = undefined;
  }

  /** Waits for every write in flight, at most 2 s; the bound timer is the scheduler's (unref'd). */
  async function settle(): Promise<void> {
    if (pending.size === 0) return;
    let bound: unknown;
    await new Promise<void>((resolve) => {
      try {
        bound = schedule.setTimeout(resolve, FLUSH_BOUND_MS);
      } catch {
        /* no bound: the writes settle or reject on their own */
      }
      void Promise.all([...pending]).then(() => resolve());
    });
    try {
      if (bound !== undefined) schedule.clearTimeout(bound);
    } catch {
      /* never throws */
    }
  }

  /** Closes the open window (a second call in the same window writes nothing) and settles. */
  function flushNow(): Promise<void> {
    try {
      roll(now());
      drain();
    } catch {
      /* never throws */
    }
    return settle().catch(() => undefined);
  }

  const root: MetricsWriter = {
    increment(name, labels = {}, by = 1) {
      try {
        if (stopped) return;
        if (typeof by !== "number" || !Number.isFinite(by) || by < 0) return;
        if (!byName(name)) return report([{ kind: "unknown-metric", name }]);
        roll(now());
        arm();
        const { key, issues: unknown } = counterKeyOf(name, labels);
        report(unknown);
        let rest = by;
        // A fractional `by` below 1 aggregates: writing 1 for it would count more than happened.
        if (by >= 1 && eagerNames.has(name) && !eagerSent.has(key)) {
          eagerSent.add(key);
          const { line, issues } = buildEvent(name, labels, windowStart);
          report(issues);
          if (line !== undefined) emit(line);
          rest = by - 1;
        }
        if (rest === 0) return;
        const series = counters.get(key);
        if (series) series.sum += rest;
        else counters.set(key, { name, labels: { ...labels }, sum: rest, seed: false });
      } catch {
        /* never throws */
      }
    },
    registerGauge(name, read) {
      try {
        if (stopped || typeof read !== "function") return;
        gauges.push({ name, read });
        arm();
      } catch {
        /* never throws */
      }
    },
  };

  applySeeds();
  if (seeds.length > 0) arm();

  return {
    ...root,
    for: (scope) => scoped(root, scope.network),
    flush() {
      if (stopped) return closing ?? Promise.resolve();
      return flushNow();
    },
    close() {
      if (closing) return closing;
      stopped = true;
      disarm();
      closing = flushNow();
      return closing;
    },
  };
}
