import { byName, EMF_LINE_PREFIX, type MetricDef } from "@stellar-x402/metrics-catalog";
import { describe, expect, it } from "vitest";
import { buildEvent, buildTick, emfLine } from "../src/adapters/emf.js";
import type { Labels } from "../src/metrics.js";

const T = 1_700_000_000_000;
const NET = "stellar:testnet";

const def = (name: string): MetricDef => {
  const d = byName(name);
  if (!d) throw new Error(`test uses an undeclared metric ${name}`);
  return d;
};

/** Builds one line and parses it; fails the test if no line came out. */
const parsed = (name: string, value: Parameters<typeof emfLine>[1], labels: Labels) => {
  const { line, issues } = emfLine(def(name), value, labels, T);
  expect(line, JSON.stringify(issues)).toBeDefined();
  return { o: JSON.parse(line!), issues };
};

const directive = (o: { _aws: { CloudWatchMetrics: unknown[] } }) =>
  o._aws.CloudWatchMetrics[0] as {
    Namespace: string;
    Dimensions: string[][];
    Metrics: { Name: string; Unit: string }[];
  };

describe("emf builder", () => {
  it("network-scoped line: network in every set, value is a number", () => {
    const { o, issues } = parsed("settlement_outcomes_total", 3, {
      network: NET,
      result: "success",
      reason: "x",
    });
    expect(issues).toEqual([]);
    expect(o._aws.CloudWatchMetrics).toHaveLength(1);
    expect(directive(o).Namespace).toBe("x402-facilitator");
    expect(directive(o).Dimensions).toEqual([["network", "result"]]);
    expect(directive(o).Metrics).toEqual([{ Name: "settlement_outcomes_total", Unit: "Count" }]);
    expect(o.settlement_outcomes_total).toBe(3);
    expect(o.network).toBe(NET);
    expect(o.result).toBe("success");
    expect(o.reason).toBe("x");

    // Two matching sets: `network` is in both.
    const pool = parsed("pool_events_total", 1, { network: NET, type: "sequence-resync" }).o;
    expect(directive(pool).Dimensions).toEqual([["network"], ["network", "type"]]);
    const plain = parsed("pool_events_total", 1, { network: NET, type: "sent" }).o;
    expect(directive(plain).Dimensions).toEqual([["network"]]);
  });

  it("missing network on a network-scoped metric -> no line, issue no-valid-set", () => {
    for (const labels of [{}, { network: "" }, { result: "success" }] as Labels[]) {
      const r = emfLine(def("settlement_outcomes_total"), 1, labels, T);
      expect(r.line).toBeUndefined();
      expect(r.issues).toContainEqual({ kind: "no-valid-set", name: "settlement_outcomes_total" });
    }
    const event = buildEvent("settlement_record_failures_total", {}, T);
    expect(event.line).toBeUndefined();
    expect(event.issues).toEqual([
      { kind: "no-valid-set", name: "settlement_record_failures_total" },
    ]);
  });

  it("http 500 line carries Dimensions [[route],[status]]; a 200 line only [[route]]", () => {
    const err = parsed("http_requests_total", 1, { route: "/settle", status: "500" }).o;
    expect(directive(err).Dimensions).toEqual([["route"], ["status"]]);
    // A number is matched as its string, and written as that string.
    const errNum = parsed("http_requests_total", 1, { route: "/settle", status: 500 }).o;
    expect(directive(errNum).Dimensions).toEqual([["route"], ["status"]]);
    expect(errNum.status).toBe("500");

    const ok = parsed("http_requests_total", 1, { route: "/settle", status: 200 });
    expect(ok.issues).toEqual([]);
    expect(directive(ok.o).Dimensions).toEqual([["route"]]);
    // `status` is in no written set, so its log field keeps the raw value.
    expect(ok.o.status).toBe(200);
    // Express answers a repeated GET with a matching weak ETag 304: a known status, no issue.
    expect(parsed("http_requests_total", 1, { route: "/supported", status: 304 }).issues).toEqual(
      [],
    );

    // A process-scoped metric never bills `network`.
    const net = parsed("http_requests_total", 1, {
      route: "/verify",
      status: "200",
      network: NET,
    }).o;
    expect(directive(net).Dimensions).toEqual([["route"]]);
  });

  it("a when on a label that is no dimension gates the set", () => {
    const near = parsed("spend_budget_nearing_total", 1, { network: NET, budget: "asset" }).o;
    expect(directive(near).Dimensions).toEqual([["network"]]);
    expect(near.budget).toBe("asset");
  });

  it("no set's when matches -> no line and no issue (a designed-silent path)", () => {
    const silent: [string, Labels][] = [
      ["spend_budget_nearing_total", { network: NET, budget: "payer" }],
      ["settlement_refused_after_verify_total", { network: NET, stage: "check" }],
      ["spend_failure_attributed_total", { network: NET, fault: "payer" }],
    ];
    for (const [name, labels] of silent) {
      const r = emfLine(def(name), 1, labels, T);
      expect(r.line, name).toBeUndefined();
      expect(r.issues, name).toEqual([]);
    }
    // A matching when with an invalid dimension is still reported.
    const r = emfLine(def("settlement_refused_after_verify_total"), 1, { stage: "pool" }, T);
    expect(r.line).toBeUndefined();
    expect(r.issues).toEqual([
      { kind: "no-valid-set", name: "settlement_refused_after_verify_total" },
    ]);
  });

  it("unknown billed value -> 'other' + unknown-value issue; log fields keep the raw value", () => {
    const { o, issues } = parsed("http_requests_total", 1, {
      route: "/admin",
      status: 302,
      reason: "x",
      replay: false,
      attempts: 3,
      big: 10n,
    });
    expect(issues).toEqual([
      { kind: "unknown-value", name: "http_requests_total", dim: "route", value: "/admin" },
      { kind: "unknown-value", name: "http_requests_total", dim: "status", value: "302" },
    ]);
    expect(directive(o).Dimensions).toEqual([["route"]]);
    expect(o.route).toBe("other");
    // `status` is billed but in no written set: the raw value, not `other`.
    expect(o.status).toBe(302);
    expect(o.reason).toBe("x");
    expect(o.replay).toBe(false);
    expect(o.attempts).toBe(3);
    expect(o.big).toBe("10");
  });

  it("bigint value -> number; NaN/Infinity -> no line + non-finite issue", () => {
    const { o } = parsed("settlement_outcomes_total", 7n, { network: NET, result: "success" });
    expect(o.settlement_outcomes_total).toBe(7);
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = emfLine(
        def("settlement_outcomes_total"),
        bad,
        { network: NET, result: "error" },
        T,
      );
      expect(r.line).toBeUndefined();
      expect(r.issues).toEqual([{ kind: "non-finite", name: "settlement_outcomes_total" }]);
    }
  });

  it("empty-string billed value -> set invalid", () => {
    // The `[route]` set is invalid; the `[status]` set still goes out.
    const err = parsed("http_requests_total", 1, { route: "", status: "500" }).o;
    expect(directive(err).Dimensions).toEqual([["status"]]);
    // With only the `[route]` set matching, nothing is valid. Empty is not rewritten to `other`.
    const r = emfLine(def("http_requests_total"), 1, { route: "", status: "200" }, T);
    expect(r.line).toBeUndefined();
    expect(r.issues).toEqual([{ kind: "no-valid-set", name: "http_requests_total" }]);
    // An open dimension: empty, over 1024 characters, or not printable is invalid too.
    for (const mount of ["", "x".repeat(1025), "/var\n", "   "]) {
      const d = emfLine(def("disk_used_percent"), 50, { mount }, T);
      expect(d.line, JSON.stringify(mount)).toBeUndefined();
      expect(d.issues).toEqual([{ kind: "no-valid-set", name: "disk_used_percent" }]);
    }
    const ok = parsed("disk_used_percent", 50, { mount: "x".repeat(1024) }).o;
    expect(directive(ok).Dimensions).toEqual([["mount"]]);
  });

  it("gauge with samples writes a Values array (<=100, finite only)", () => {
    const { o, issues } = parsed("settlement_oldest_open_seconds", [1, NaN, 2.5, Infinity, 3], {
      network: NET,
    });
    expect(issues).toEqual([{ kind: "non-finite", name: "settlement_oldest_open_seconds" }]);
    expect(directive(o).Metrics).toEqual([
      { Name: "settlement_oldest_open_seconds", Unit: "Seconds" },
    ]);
    expect(o.settlement_oldest_open_seconds).toEqual([1, 2.5, 3]);

    const many = Array.from({ length: 150 }, (_, i) => i);
    const capped = parsed("pool_queued", many, { network: NET });
    expect(capped.issues).toEqual([]);
    expect(capped.o.pool_queued).toEqual(many.slice(0, 100));

    // No samples is nothing to write, not an issue; only non-finite samples is one.
    const none = emfLine(def("pool_queued"), [], { network: NET }, T);
    expect(none).toEqual({ issues: [] });
    const bad = emfLine(def("pool_queued"), [NaN, Infinity], { network: NET }, T);
    expect(bad).toEqual({ issues: [{ kind: "non-finite", name: "pool_queued" }] });
  });

  it("unknown metric name -> no line + unknown-metric issue (never throws)", () => {
    const tick = buildTick(
      {
        counters: [
          { name: "nope_total", value: 1, labels: { network: NET } },
          { name: "settlement_record_failures_total", value: 2, labels: { network: NET } },
        ],
        gauges: [{ name: "pool_queued", value: 4, labels: { network: NET } }],
      },
      T,
    );
    expect(tick.issues).toEqual([{ kind: "unknown-metric", name: "nope_total" }]);
    // One line per valid reading, counters then gauges.
    expect(tick.lines.map((l) => Object.keys(JSON.parse(l)).at(-1))).toEqual([
      "settlement_record_failures_total",
      "pool_queued",
    ]);
    expect(JSON.parse(tick.lines[0]!).settlement_record_failures_total).toBe(2);

    expect(() => buildEvent("nope_total", {}, T)).not.toThrow();
    expect(buildEvent("nope_total", {}, T)).toEqual({
      issues: [{ kind: "unknown-metric", name: "nope_total" }],
    });
  });

  it("line starts with EMF_LINE_PREFIX; Timestamp is the passed window start", () => {
    const { line } = buildEvent("settlement_record_failures_total", { network: NET }, T);
    expect(line!.startsWith(EMF_LINE_PREFIX)).toBe(true);
    const o = JSON.parse(line!);
    expect(Object.keys(o)[0]).toBe("_aws");
    expect(o._aws.Timestamp).toBe(T);
    expect(o.settlement_record_failures_total).toBe(1);

    const tick = buildTick(
      { counters: [], gauges: [{ name: "pool_queued", value: 0, labels: { network: NET } }] },
      T + 60_000,
    );
    expect(tick.lines[0]!.startsWith(EMF_LINE_PREFIX)).toBe(true);
    expect(JSON.parse(tick.lines[0]!)._aws.Timestamp).toBe(T + 60_000);
  });

  it("a label named like the metric or _aws is dropped", () => {
    const { o } = parsed("settlement_record_failures_total", 2, {
      network: NET,
      settlement_record_failures_total: 99,
      _aws: "spoof",
      kept: "yes",
    });
    expect(o.settlement_record_failures_total).toBe(2);
    expect(o._aws.Timestamp).toBe(T);
    expect(Object.keys(o).filter((k) => k === "_aws")).toHaveLength(1);
    expect(o.kept).toBe("yes");
  });
});
