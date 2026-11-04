// Pure EMF (CloudWatch Embedded Metric Format) line builder. No process, no stdout, no I/O, no
// logging: it returns lines plus the issues it found, and the adapter (./emf-metrics.ts) writes
// the lines and logs the issues. Rules: lore 0027 notes/S-pr112-spine.md, AD-2 and AD-4. Which
// sets a metric has and which values a dim takes come from the catalog (`effectiveSets`,
// `isDimValue`, `whenHolds`), the same rule the alarms check a series with (`seriesDims`).
import {
  byName,
  effectiveSets,
  isDimValue,
  whenHolds,
  type MetricDef,
} from "@stellar-x402/metrics-catalog";
import type { Labels } from "../metrics.js";

/** A scalar for a counter or a gauge read once; an array for a gauge's samples in the window. */
export type Reading = { name: string; value: number | bigint | readonly number[]; labels: Labels };

export interface MetricsSnapshot {
  counters: Reading[];
  gauges: Reading[];
}

export interface BuildIssue {
  /**
   * `no-valid-set`: a set's `when` matched (or it had none) but a dimension had no valid value. A
   * line whose sets all have a `when` that doesn't match is a designed-silent path, no issue.
   * `read-failed` comes from the adapter only: a gauge's `read()` threw.
   */
  kind: "unknown-metric" | "unknown-value" | "no-valid-set" | "non-finite" | "read-failed";
  name: string;
  /** For `unknown-value`: the dimension, and the value written as `other`. */
  dim?: string;
  value?: string;
}

/** EMF's limit on the values of one metric in one line. */
export const MAX_VALUES = 100;

// BigInt is not valid JSON; a bigint log field is written as a decimal string.
const bigintAsString = (_key: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/**
 * The value a dimension is written as: the label as a string, or `other` for one outside the
 * dimension's closed list (`unknown`, with the raw value). `undefined` for a missing, empty,
 * overlong or unprintable value, which leaves every set holding the dimension invalid. The one
 * home of the rule: the writer keys its window with it too.
 */
export function dimValue(
  def: MetricDef,
  dim: string,
  raw: Labels[string] | null | undefined,
): { value: string; unknown?: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw);
  if (!isDimValue(s)) return undefined;
  const closed = def.values?.[dim];
  return closed && !closed.includes(s) ? { value: "other", unknown: s } : { value: s };
}

/** Each billed dimension's written value ({@link dimValue}), with an issue for each `other`. */
function billedValues(def: MetricDef, labels: Labels, issues: BuildIssue[]): Map<string, string> {
  const dims = new Set(effectiveSets(def).flatMap((s) => s.dims));
  const out = new Map<string, string>();
  for (const dim of dims) {
    const written = dimValue(def, dim, labels[dim]);
    if (!written) continue;
    if (written.unknown !== undefined)
      issues.push({ kind: "unknown-value", name: def.name, dim, value: written.unknown });
    out.set(dim, written.value);
  }
  return out;
}

/**
 * Every set whose `when` matches and whose dimensions all have a valid value, with `network`
 * first in each set of a network-scoped metric, and whether any set's `when` matched at all. A
 * `when` label that is billed matches on its written value; one that is not matches on
 * `String(label)`.
 */
function validSets(
  def: MetricDef,
  labels: Labels,
  billed: Map<string, string>,
): { sets: string[][]; matched: boolean } {
  const matchValue = (label: string): string | undefined => {
    if (billed.has(label)) return billed.get(label);
    const raw = labels[label];
    return raw === undefined || raw === null ? undefined : String(raw);
  };
  const sets: string[][] = [];
  let matched = false;
  for (const set of effectiveSets(def)) {
    if (!whenHolds(set, matchValue)) continue;
    matched = true;
    if (set.dims.every((d) => billed.has(d))) sets.push([...set.dims]);
  }
  return { sets, matched };
}

/** The metric's written value: a finite number, or the finite samples (at most 100). */
function metricValue(
  def: MetricDef,
  value: Reading["value"],
  issues: BuildIssue[],
): number | number[] | undefined {
  // Anything but an array goes through `Number()`, so a stray `undefined` is a non-finite value.
  if (!Array.isArray(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    issues.push({ kind: "non-finite", name: def.name });
    return undefined;
  }
  const finite = value.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (finite.length < value.length) issues.push({ kind: "non-finite", name: def.name });
  return finite.length > 0 ? finite.slice(0, MAX_VALUES) : undefined;
}

/**
 * One EMF line for one reading, carrying every valid set in one directive. No line when no set
 * is valid or the value is not finite; the reason is in `issues`, except when no set's `when`
 * matched. A label is written as its billed value only if it is in a written set; any other label
 * (a billed dimension outside the written sets included) keeps its raw value as a log field.
 */
export function emfLine(
  def: MetricDef,
  value: Reading["value"],
  labels: Labels,
  ts: number,
): { line?: string; issues: BuildIssue[] } {
  const issues: BuildIssue[] = [];
  const billed = billedValues(def, labels, issues);
  const { sets, matched } = validSets(def, labels, billed);
  const written = metricValue(def, value, issues);
  if (sets.length === 0 && matched) issues.push({ kind: "no-valid-set", name: def.name });
  if (sets.length === 0 || written === undefined) return { issues };

  const inSets = new Set(sets.flat());
  const fields: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(labels)) {
    if (key === "_aws" || key === def.name) continue;
    fields[key] = inSets.has(key) ? billed.get(key) : v;
  }
  const line = JSON.stringify(
    {
      _aws: {
        Timestamp: ts,
        CloudWatchMetrics: [
          {
            Namespace: def.namespace,
            Dimensions: sets,
            Metrics: [{ Name: def.name, Unit: def.unit }],
          },
        ],
      },
      ...fields,
      [def.name]: written,
    },
    bigintAsString,
  );
  return { line, issues };
}

/** One line per reading, counters then gauges. Generic over the snapshot; no per-name branches. */
export function buildTick(
  snapshot: MetricsSnapshot,
  ts: number,
): { lines: string[]; issues: BuildIssue[] } {
  const lines: string[] = [];
  const issues: BuildIssue[] = [];
  for (const r of [...snapshot.counters, ...snapshot.gauges]) {
    const def = byName(r.name);
    if (!def) {
      issues.push({ kind: "unknown-metric", name: r.name });
      continue;
    }
    const built = emfLine(def, r.value, r.labels, ts);
    if (built.line !== undefined) lines.push(built.line);
    issues.push(...built.issues);
  }
  return { lines, issues };
}

/** One `Sum=1` line for an eager-first counter's first increment in a window. */
export function buildEvent(
  name: string,
  labels: Labels,
  ts: number,
): { line?: string; issues: BuildIssue[] } {
  const def = byName(name);
  if (!def) return { issues: [{ kind: "unknown-metric", name }] };
  return emfLine(def, 1, labels, ts);
}
