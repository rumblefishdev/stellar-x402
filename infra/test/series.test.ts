// `make check-series`'s gate (decisions 26 and 33), on a canned `list-metrics` answer: a series it
// gets wrong lets a group go on over series that don't exist.
import { describe, expect, test } from "vitest";
import type { SeriesRef } from "../src/lib/alarms/factory.js";
import {
  type ListMetricsOutput,
  alwaysWritten,
  listMetricsArgs,
  listsExactSeries,
} from "../src/lib/series.js";

const series = (
  namespace: string,
  metricName: string,
  dims: Record<string, string> = {},
): SeriesRef => ({ namespace, metricName, dims });

describe("alwaysWritten", () => {
  test.each([
    ["a facilitator gauge", series("x402-facilitator", "pool_queued", { network: "n" }), true],
    ["an agent gauge", series("x402-host", "disk_used_percent", { path: "/" }), true],
    ["a probe gauge", series("x402-host", "openbao_up"), true],
    [
      "the sweeps' listed zero",
      series("x402-facilitator", "settlement_sweeps_total", { network: "n", outcome: "listed" }),
      true,
    ],
    [
      "a failed sweep",
      series("x402-facilitator", "settlement_sweeps_total", { network: "n", outcome: "failed" }),
      false,
    ],
    ["a failure counter", series("x402-facilitator", "signer_failures_total"), false],
    ["a host counter", series("x402-host", "watchdog_restarts_total"), false],
    ["an off-server count", series("x402-watch", "account_effects_unexpected"), true],
    ["the uptime probe's ready", series("x402-watch", "ready"), true],
    ["a Lambda's invocations", series("AWS/Lambda", "Invocations", { FunctionName: "f" }), true],
    ["a Lambda's errors", series("AWS/Lambda", "Errors", { FunctionName: "f" }), true],
    ["a Lambda's throttles", series("AWS/Lambda", "Throttles", { FunctionName: "f" }), false],
    ["a log group's bytes", series("AWS/Logs", "IncomingBytes", { LogGroupName: "g" }), true],
    ["an EMF error", series("AWS/Logs", "EMFValidationErrors", { LogGroupName: "g" }), false],
  ])("%s", (_, s, expected) => {
    expect(alwaysWritten(s)).toBe(expected);
  });
});

describe("listMetricsArgs", () => {
  test("asks for one series active in the last 3 hours, as JSON", () => {
    expect(listMetricsArgs("eu-central-1", series("x402-host", "openbao_up"))).toEqual([
      "cloudwatch",
      "list-metrics",
      "--region",
      "eu-central-1",
      "--namespace",
      "x402-host",
      "--metric-name",
      "openbao_up",
      "--recently-active",
      "PT3H",
      "--output",
      "json",
    ]);
  });

  test("passes the dimensions as JSON, so a value with , or = stays whole", () => {
    const dims = { path: "/srv/a,b=c", network: "stellar:testnet" };
    const args = listMetricsArgs("eu-central-1", series("x402-host", "disk_used_percent", dims));
    const at = args.indexOf("--dimensions");
    expect(at).toBeGreaterThan(0);
    expect(JSON.parse(args[at + 1]!)).toEqual([
      { Name: "path", Value: "/srv/a,b=c" },
      { Name: "network", Value: "stellar:testnet" },
    ]);
    expect(args[at + 2]).toBe("--output");
  });
});

describe("listsExactSeries", () => {
  // `aws cloudwatch list-metrics --output json`, trimmed: the agent's own dimensions on one disk
  // line, the exact set on another mount, and a network series.
  const answer: ListMetricsOutput = JSON.parse(`{
    "Metrics": [
      {
        "Namespace": "x402-host",
        "MetricName": "disk_used_percent",
        "Dimensions": [
          { "Name": "path", "Value": "/" },
          { "Name": "host", "Value": "ch-prod-01" },
          { "Name": "device", "Value": "sda1" },
          { "Name": "fstype", "Value": "ext4" }
        ]
      },
      {
        "Namespace": "x402-host",
        "MetricName": "disk_used_percent",
        "Dimensions": [{ "Name": "path", "Value": "/var/lib/docker" }]
      },
      {
        "Namespace": "x402-facilitator",
        "MetricName": "pool_queued",
        "Dimensions": [{ "Name": "network", "Value": "stellar:testnet" }]
      }
    ]
  }`);

  test("finds a series listed with exactly the alarm's dimensions", () => {
    expect(listsExactSeries(answer, { path: "/var/lib/docker" })).toBe(true);
    expect(listsExactSeries(answer, { network: "stellar:testnet" })).toBe(true);
  });

  test("doesn't take a series with more dimensions, which the alarm never reads", () => {
    expect(listsExactSeries(answer, { path: "/" })).toBe(false);
  });

  test("doesn't take a series with fewer dimensions or another value", () => {
    expect(listsExactSeries(answer, { network: "stellar:testnet", outcome: "listed" })).toBe(false);
    expect(listsExactSeries(answer, { network: "stellar:pubnet" })).toBe(false);
    expect(listsExactSeries(answer, {})).toBe(false);
  });

  test("finds a dimensionless series only when listed without dimensions", () => {
    expect(listsExactSeries({ Metrics: [{ Dimensions: [] }] }, {})).toBe(true);
    expect(listsExactSeries({ Metrics: [] }, {})).toBe(false);
  });
});
