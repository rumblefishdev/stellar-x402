// Prometheus adapter (lore 0139, ADR 0011 "Metrics"): the facilitator's metrics as Prometheus text
// on `/metrics`, for the agent on the server to scrape. It replaced the EMF adapter at the switch
// (0139 AC3); `main()` serves it on `METRICS_PORT`.
//
// - A series' labels are the union of its catalog sets' dims, plus `network` for a network-scoped
//   metric, plus its `fieldValues` fields (below). A set's `when` on a dim only limited what
//   CloudWatch billed, so every label is always written and a rule filters on it. A `when` on a
//   label that is no dim still decides whether the line counts (`spend_budget_nearing_total`'s
//   `budget`, as `seriesDims` says).
// - A field with closed values in the catalog's `fieldValues` is a label too, after the dims; any
//   other field stays in the app line (0139 step 4). `rpc` is written as its `RPC_URLS` index.
// - Every counter starts at 0 for every closed label value, so a missing series is a fault.
// - Gauges are read at scrape time; each series has `<name>_last_read_timestamp_seconds`, which
//   stops moving when its read fails or has no value.
// - `markStarted()` writes the liveness series once the service has started.
import {
  byName,
  CATALOG,
  effectiveSets,
  isDimValue,
  whenHolds,
  type MetricDef,
  type Network,
} from "@stellar-x402/metrics-catalog";
import { isStellarNetwork } from "@stellar-x402/config";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  scoped,
  seriesKey as keyOf,
  type GaugeRead,
  type Labels,
  type MetricsWriter,
  type ProcessMetrics,
} from "../metrics.js";

/** The text format's content type (exposition format 0.0.4). */
export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
/** The liveness series: the start's time, in seconds, written once `start()` has resolved. */
export const STARTED_METRIC = "facilitator_started_timestamp_seconds";
export const LAST_READ_SUFFIX = "_last_read_timestamp_seconds";
/** Distinct issues remembered; a new one past the cap is dropped, so a flood stays bounded. */
const MAX_ISSUE_KEYS = 1_000;

export interface MetricIssue {
  /** `missing-label`: a label of the series was not given and is written as `other`. */
  kind:
    | "unknown-metric"
    | "unknown-value"
    | "missing-label"
    | "non-finite"
    | "negative"
    | "read-failed";
  name: string;
  label?: string;
  value?: string;
}

/**
 * The metric's label keys in a fixed order: `network` first, then its sets' dims as declared, then
 * its fields with closed values.
 */
export function labelKeys(def: MetricDef): string[] {
  const dims = effectiveSets(def).flatMap((set) => set.dims);
  return [...new Set([...dims, ...Object.keys(def.fieldValues ?? {})])];
}

/** A label's closed values: a dim's `values` or a field's `fieldValues`; none for an open dim. */
const closedValues = (def: MetricDef, key: string) => def.values?.[key] ?? def.fieldValues?.[key];

// ponytail: the one label rewritten here; main.ts could pass the index itself.
const RPC_INDEX = /^RPC_URLS\[(\d+)\]#/;

/**
 * Whether the line counts: some set's `when`, on the labels that are no dim of the metric, holds.
 * A `when` on a dim never filters here (the label is written instead), and a set without one holds.
 */
function counts(def: MetricDef, labels: Labels): boolean {
  // The sets' dims only: a `when` on a field keeps filtering even once the field is a label.
  const dims = new Set(effectiveSets(def).flatMap((set) => set.dims));
  return effectiveSets(def).some((set) =>
    whenHolds(
      { when: Object.fromEntries(Object.entries(set.when ?? {}).filter(([k]) => !dims.has(k))) },
      (label) => (labels[label] === undefined ? undefined : String(labels[label])),
    ),
  );
}

/** Every combination of the closed values of `keys`, for the zero series. */
function combinations(def: MetricDef, keys: string[], networks: readonly Network[]): Labels[] {
  return keys.reduce<Labels[]>(
    (acc, key) => {
      const values = key === "network" ? networks : (closedValues(def, key) ?? []);
      return acc.flatMap((labels) => values.map((v) => ({ ...labels, [key]: v })));
    },
    [{}],
  );
}

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** One sample line; the labels are already in their written order. */
function sampleLine(name: string, labels: Record<string, string>, value: number): string {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`);
  // Finite only: `increment` and `readGauges` refuse anything else.
  return `${name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${value}`;
}

export function prometheusMetrics(opts: {
  /** The networks the process serves: the zero series of network-scoped counters. */
  networks: readonly Network[];
  now?: () => number;
  /** Each distinct issue once (per kind, name, label and value), at most 1000 of them. */
  onIssue?: (issue: MetricIssue) => void;
}): ProcessMetrics & {
  /** Writes the liveness series: call it once the service has started. */
  markStarted(): void;
  /**
   * The exposition text: what `GET /metrics` answers. Reads every gauge; a read that throws only
   * loses its sample. Anything else that throws reaches `metricsListener`, which answers 500.
   */
  render(): string;
} {
  const now = opts.now ?? Date.now;
  const issueKeys = new Set<string>();
  const counters = new Map<
    string,
    { name: string; labels: Record<string, string>; value: number }
  >();
  /** `stamp`: the key of the series the registration last read, whose stamp it moves. */
  const gauges: { name: string; read: GaugeRead; stamp?: string }[] = [];
  /** A gauge series' last successful read, in seconds, kept when a later read fails. */
  const lastRead = new Map<string, { name: string; labels: Record<string, string>; at: number }>();
  let startedAt: number | undefined;

  function report(issue: MetricIssue): void {
    const key = JSON.stringify([issue.kind, issue.name, issue.label ?? null, issue.value ?? null]);
    if (issueKeys.has(key) || issueKeys.size >= MAX_ISSUE_KEYS) return;
    issueKeys.add(key);
    try {
      opts.onIssue?.(issue);
    } catch {
      /* a failing logger must not stop the writer */
    }
  }

  /**
   * The series' labels as written: each label key of the metric, in order, with a value outside
   * its closed list, or none, written as `other`. Labels the metric doesn't have are dropped.
   */
  function written(def: MetricDef, labels: Labels): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of labelKeys(def)) {
      const raw = labels[key];
      if (raw === undefined) {
        report({ kind: "missing-label", name: def.name, label: key });
        out[key] = "other";
        continue;
      }
      const s = key === "rpc" ? (RPC_INDEX.exec(String(raw))?.[1] ?? String(raw)) : String(raw);
      const closed = closedValues(def, key);
      const ok =
        key === "network"
          ? isStellarNetwork(s)
          : isDimValue(s) && (closed === undefined || closed.includes(s));
      if (!ok) report({ kind: "unknown-value", name: def.name, label: key, value: s });
      out[key] = ok ? s : "other";
    }
    return out;
  }

  // The zero series: every facilitator counter, every closed value.
  for (const def of CATALOG as readonly MetricDef[]) {
    if (def.namespace !== "x402-facilitator" || def.kind !== "counter") continue;
    for (const labels of combinations(def, labelKeys(def), opts.networks)) {
      const w = labels as Record<string, string>;
      counters.set(keyOf(def.name, w), { name: def.name, labels: w, value: 0 });
    }
  }

  const root: MetricsWriter = {
    increment(name, labels = {}, by = 1) {
      try {
        if (typeof by !== "number" || !Number.isFinite(by))
          return report({ kind: "non-finite", name });
        if (by < 0) return report({ kind: "negative", name });
        const def = byName(name);
        if (!def) return report({ kind: "unknown-metric", name });
        if (!counts(def, labels)) return;
        const w = written(def, labels);
        const key = keyOf(name, w);
        const series = counters.get(key);
        if (series) series.value += by;
        else counters.set(key, { name, labels: w, value: by });
      } catch {
        /* never throws */
      }
    },
    registerGauge(name, read) {
      if (typeof read === "function") gauges.push({ name, read });
    },
  };

  /** Reads every gauge once: the samples of this scrape, and the last-read stamps updated. */
  function readGauges() {
    const samples: { name: string; labels: Record<string, string>; value: number }[] = [];
    for (const gauge of gauges) {
      const { name, read } = gauge;
      const def = byName(name);
      if (!def) {
        report({ kind: "unknown-metric", name });
        continue;
      }
      let r: ReturnType<GaugeRead>;
      try {
        r = read();
      } catch {
        report({ kind: "read-failed", name });
        continue;
      }
      // No value yet (a reconciler that hasn't listed): no sample, and the stamp doesn't move.
      if (r === undefined) continue;
      const value = typeof r.value === "bigint" ? Number(r.value) : r.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        report({ kind: "non-finite", name });
        continue;
      }
      const labels = written(def, r.labels ?? {});
      samples.push({ name, labels, value });
      // One registration reads one series. A stamp under labels it no longer reads (`rpc` before a
      // failover) would stop moving and fire its age rule while the gauge reads fine, so it goes.
      const key = keyOf(name, labels);
      if (gauge.stamp !== undefined && gauge.stamp !== key) lastRead.delete(gauge.stamp);
      gauge.stamp = key;
      lastRead.set(key, { name, labels, at: now() / 1000 });
    }
    return samples;
  }

  function render(): string {
    const families = new Map<string, { type: "counter" | "gauge"; lines: string[] }>();
    const add = (name: string, type: "counter" | "gauge", line: string) => {
      const family = families.get(name) ?? { type, lines: [] };
      family.lines.push(line);
      families.set(name, family);
    };
    for (const s of counters.values())
      add(s.name, "counter", sampleLine(s.name, s.labels, s.value));
    for (const s of readGauges()) add(s.name, "gauge", sampleLine(s.name, s.labels, s.value));
    for (const s of lastRead.values()) {
      const name = s.name + LAST_READ_SUFFIX;
      add(name, "gauge", sampleLine(name, s.labels, s.at));
    }
    if (startedAt !== undefined)
      add(STARTED_METRIC, "gauge", sampleLine(STARTED_METRIC, {}, startedAt));
    return [...families.keys()]
      .sort()
      .flatMap((name) => {
        const f = families.get(name)!;
        return [`# TYPE ${name} ${f.type}`, ...f.lines.sort()];
      })
      .join("\n")
      .concat("\n");
  }

  return {
    ...root,
    for: (scope) => scoped(root, scope.network),
    markStarted() {
      startedAt = now() / 1000;
    },
    render,
  };
}

/**
 * A `node:http` listener answering `GET /metrics` with `render()`, and 404 to anything else. A
 * render that throws answers 500, so the scrape fails (`up == 0`) instead of reading as no samples.
 */
export function metricsListener(render: () => string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    let body: string;
    try {
      body = render();
    } catch {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPE }).end(body);
  };
}
