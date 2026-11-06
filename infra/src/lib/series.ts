// What `make check-series` decides, apart from the AWS call: which series must already have data
// before a group goes on (0027 decisions 26 and 33), how to ask `list-metrics` for one, and whether
// its answer holds the exact series an alarm reads.
import { byName } from "@stellar-x402/metrics-catalog";
import type { SeriesRef } from "./alarms/factory.js";

/** Written whatever happens, so its absence means the path is broken. */
export function alwaysWritten(s: SeriesRef): boolean {
  if (s.namespace === "AWS/Lambda")
    return s.metricName === "Invocations" || s.metricName === "Errors";
  if (s.namespace === "AWS/Logs") return s.metricName === "IncomingBytes";
  // The only zero the facilitator writes (the spine's AD-4).
  if (s.metricName === "settlement_sweeps_total") return s.dims["outcome"] === "listed";
  // The two Lambdas publish each metric of a section that read in full on every run, 0 included
  // (decision 39). A section whose read failed publishes nothing, never a 0 that would read as an
  // empty account or no theft, so a missing series means a broken path or a failing read, and
  // the group stays off.
  if (s.namespace === "x402-watch") return true;
  return byName(s.metricName)?.kind === "gauge";
}

/**
 * `aws cloudwatch list-metrics` arguments for one series with data in the last 3 hours. The
 * dimensions go as JSON: the CLI's `Name=…,Value=…` shorthand splits a value holding `,` or `=`,
 * which a dimension value may.
 */
export function listMetricsArgs(region: string, s: SeriesRef): string[] {
  const dims = Object.entries(s.dims);
  return [
    "cloudwatch",
    "list-metrics",
    "--region",
    region,
    "--namespace",
    s.namespace,
    "--metric-name",
    s.metricName,
    "--recently-active",
    "PT3H",
    ...(dims.length
      ? ["--dimensions", JSON.stringify(dims.map(([Name, Value]) => ({ Name, Value })))]
      : []),
    "--output",
    "json",
  ];
}

/** `list-metrics --output json`, as far as the check reads it. */
export interface ListMetricsOutput {
  readonly Metrics: readonly { readonly Dimensions: readonly { Name: string; Value: string }[] }[];
}

/**
 * Whether `list-metrics` returned the series with exactly these dimensions. It also returns series
 * with more dimensions than asked (the agent's `host`, `device` and `fstype`, say), and an alarm
 * reads only the exact set.
 */
export function listsExactSeries(
  out: ListMetricsOutput,
  dims: Readonly<Record<string, string>>,
): boolean {
  const want = Object.entries(dims);
  return out.Metrics.some(
    (m) =>
      m.Dimensions.length === want.length &&
      want.every(([n, v]) => m.Dimensions.some((d) => d.Name === n && d.Value === v)),
  );
}
