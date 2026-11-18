import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CONTENT_TYPE,
  metricsListener,
  prometheusMetrics,
  type MetricIssue,
} from "../src/adapters/prometheus-metrics.js";

const NET = "stellar:testnet";
const T = 1_700_000_000_000;

function setup() {
  const issues: MetricIssue[] = [];
  let t = T;
  const m = prometheusMetrics({
    networks: [NET],
    now: () => t,
    onIssue: (i) => issues.push(i),
  });
  /** The samples of one scrape, keyed by `name{labels}`. */
  const scrape = () =>
    new Map(
      m
        .render()
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const at = l.lastIndexOf(" ");
          return [l.slice(0, at), Number(l.slice(at + 1))] as const;
        }),
    );
  return { m, issues, scrape, tick: (ms: number) => (t += ms) };
}

describe("prometheus adapter", () => {
  it("starts every facilitator counter at 0 for every closed value", () => {
    const { scrape } = setup();
    const s = scrape();
    for (const result of ["success", "error", "other"])
      expect(s.get(`settlement_outcomes_total{network="${NET}",result="${result}"}`)).toBe(0);
    // A process-scoped counter has no network; the union of the sets' dims, `when` ignored.
    const http = [...s.keys()].filter((k) => k.startsWith("http_requests_total{"));
    expect(http).toHaveLength(6 * 12);
    expect(s.get('http_requests_total{route="/verify",status="503"}')).toBe(0);
    // A counter with no dims: one series per network.
    expect(s.get(`settlement_uncertain_total{network="${NET}"}`)).toBe(0);
    // Only facilitator metrics: the host's and the Lambdas' are written elsewhere.
    expect([...s.keys()].some((k) => k.startsWith("watchdog_restarts_total"))).toBe(false);
  });

  it("counts through the network child, drops log fields, and writes bad values as other", () => {
    const { m, scrape, issues } = setup();
    const net = m.for({ network: NET });
    net.increment("settlement_outcomes_total", { result: "success", reason: "x" });
    net.increment("settlement_outcomes_total", { result: "success" }, 2);
    m.increment("http_requests_total", { route: "/nope", status: "200" });
    m.increment("http_requests_total", { route: "/verify" });
    const s = scrape();
    expect(s.get(`settlement_outcomes_total{network="${NET}",result="success"}`)).toBe(3);
    expect(s.get('http_requests_total{route="other",status="200"}')).toBe(1);
    expect(s.get('http_requests_total{route="/verify",status="other"}')).toBe(1);
    expect(issues).toEqual([
      { kind: "unknown-value", name: "http_requests_total", label: "route", value: "/nope" },
      { kind: "missing-label", name: "http_requests_total", label: "status" },
    ]);
  });

  it("ignores a negative or non-finite step and never throws", () => {
    const { m, scrape, issues } = setup();
    const net = m.for({ network: NET });
    net.increment("settlement_uncertain_total", {}, -1);
    net.increment("settlement_uncertain_total", {}, Number.NaN);
    expect(scrape().get(`settlement_uncertain_total{network="${NET}"}`)).toBe(0);
    expect(issues.map((i) => i.kind)).toEqual(["negative", "non-finite"]);
  });

  it("reads gauges at scrape time and stamps each successful read", () => {
    const { m, scrape, tick } = setup();
    let queued: number | undefined = undefined;
    let fail = false;
    m.for({ network: NET }).registerGauge("pool_queued", () => {
      if (fail) throw new Error("boom");
      return queued === undefined ? undefined : { value: queued, labels: { busy: 2 } };
    });
    const series = `pool_queued{network="${NET}"}`;
    const stamp = `pool_queued_last_read_timestamp_seconds{network="${NET}"}`;

    // No value yet: neither the sample nor its stamp.
    expect(scrape().has(series)).toBe(false);
    expect(scrape().has(stamp)).toBe(false);

    queued = 4;
    let s = scrape();
    expect(s.get(series)).toBe(4);
    expect(s.get(stamp)).toBe(T / 1000);

    // A failing read: no sample, and the stamp stays where the last good read left it.
    fail = true;
    tick(30_000);
    s = scrape();
    expect(s.has(series)).toBe(false);
    expect(s.get(stamp)).toBe(T / 1000);

    fail = false;
    s = scrape();
    expect(s.get(stamp)).toBe(T / 1000 + 30);
  });

  it("writes the liveness series only once started", () => {
    const { m, scrape, tick } = setup();
    expect(scrape().has("facilitator_started_timestamp_seconds")).toBe(false);
    tick(5_000);
    m.markStarted();
    expect(scrape().get("facilitator_started_timestamp_seconds")).toBe(T / 1000 + 5);
  });

  it("writes one TYPE line per family, before its samples", () => {
    const { m } = setup();
    m.for({ network: NET }).registerGauge("pool_quarantined", () => ({ value: 1 }));
    const lines = m.render().trimEnd().split("\n");
    const types = lines.filter((l) => l.startsWith("# TYPE "));
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain("# TYPE pool_quarantined gauge");
    expect(types).toContain("# TYPE settlement_outcomes_total counter");
    for (const [i, line] of lines.entries()) {
      if (line.startsWith("#")) continue;
      const family = line.split(/[{ ]/)[0];
      const typeAt = lines.findIndex((l) => l.startsWith(`# TYPE ${family} `));
      expect(typeAt, line).toBeGreaterThanOrEqual(0);
      expect(typeAt, line).toBeLessThan(i);
      expect(line).toMatch(/^[a-z_]+(\{([a-z_]+="[^"]*",?)+\})? -?[0-9.e+]+$/);
    }
  });

  it("serves the text on GET /metrics only", async () => {
    const { m } = setup();
    const server = createServer(metricsListener(m.render));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe(CONTENT_TYPE);
      expect(await ok.text()).toContain("# TYPE settlement_outcomes_total counter");
      expect((await fetch(`${base}/health`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
