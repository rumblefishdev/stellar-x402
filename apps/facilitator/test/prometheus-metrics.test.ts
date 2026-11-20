import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CONTENT_TYPE,
  metricsListener,
  prometheusMetrics,
  type MetricIssue,
} from "../src/adapters/prometheus-metrics.js";
import { rpcEndpointName } from "../src/logger.js";

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
      for (const replay of ["true", "false", "other"])
        expect(
          s.get(
            `settlement_outcomes_total{network="${NET}",result="${result}",replay="${replay}"}`,
          ),
        ).toBe(0);
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
    net.increment("settlement_outcomes_total", { result: "success", reason: "x", replay: "false" });
    net.increment("settlement_outcomes_total", { result: "success", replay: "false" }, 2);
    m.increment("http_requests_total", { route: "/nope", status: "200" });
    m.increment("http_requests_total", { route: "/verify" });
    const s = scrape();
    expect(
      s.get(`settlement_outcomes_total{network="${NET}",result="success",replay="false"}`),
    ).toBe(3);
    expect(s.get('http_requests_total{route="other",status="200"}')).toBe(1);
    expect(s.get('http_requests_total{route="/verify",status="other"}')).toBe(1);
    expect(issues).toEqual([
      { kind: "unknown-value", name: "http_requests_total", label: "route", value: "/nope" },
      { kind: "missing-label", name: "http_requests_total", label: "status" },
    ]);
  });

  it("writes a field with closed values as a label, and leaves the other fields out", () => {
    const { m, scrape, issues } = setup();
    const net = m.for({ network: NET });
    net.increment("signer_failures_total", { reason: "sealed", step: "sign" });
    net.increment("signer_failures_total", { reason: "a new failure", step: "check" });
    // `reason` has no closed values here: it stays in the app line.
    net.increment("settlement_outcomes_total", { result: "error", reason: "x", replay: "true" });
    const s = scrape();
    expect(s.get(`signer_failures_total{network="${NET}",reason="sealed",step="sign"}`)).toBe(1);
    expect(s.get(`signer_failures_total{network="${NET}",reason="other",step="check"}`)).toBe(1);
    // Zero series for every closed field value too.
    expect(s.get(`signer_failures_total{network="${NET}",reason="denied",step="check"}`)).toBe(0);
    expect(s.get(`settlement_outcomes_total{network="${NET}",result="error",replay="true"}`)).toBe(
      1,
    );
    expect([...s.keys()].some((k) => k.includes('reason="x"'))).toBe(false);
    expect(issues).toEqual([
      {
        kind: "unknown-value",
        name: "signer_failures_total",
        label: "reason",
        value: "a new failure",
      },
    ]);
  });

  it("labels a gauge with its field, the RPC by its index, and leaves numbers out", () => {
    const { m, scrape } = setup();
    const net = m.for({ network: NET });
    net.registerGauge("rpc_on_fallback", () => ({
      value: 1,
      labels: { rpc: rpcEndpointName("https://rpc.example", 1) },
    }));
    net.registerGauge("pool_queued", () => ({ value: 2, labels: { channels: 5, busy: 3 } }));
    const s = scrape();
    expect(s.get(`rpc_on_fallback{network="${NET}",rpc="1"}`)).toBe(1);
    expect(s.get(`pool_queued{network="${NET}"}`)).toBe(2);
  });

  it("keeps one stamp per gauge registration when its labels change", () => {
    // After a failover `rpc` reads another index: the old index's stamp must go, or its age rule
    // would fire while the gauge reads fine.
    const { m, scrape, tick } = setup();
    let index = 0;
    m.for({ network: NET }).registerGauge("rpc_on_fallback", () => ({
      value: index === 0 ? 0 : 1,
      labels: { rpc: rpcEndpointName("https://rpc.example", index) },
    }));
    scrape();
    index = 1;
    tick(60_000);
    const s = scrape();
    const stamps = [...s.keys()].filter((k) => k.startsWith("rpc_on_fallback_last_read"));
    expect(stamps).toEqual([
      `rpc_on_fallback_last_read_timestamp_seconds{network="${NET}",rpc="1"}`,
    ]);
    expect(s.get(stamps[0]!)).toBe((T + 60_000) / 1000);
  });

  it("counts a line only when a when on a label that is no dim holds", () => {
    // `budget` is no dim of spend_budget_nearing_total: payer and pay_to write no metric.
    const { m, scrape } = setup();
    const net = m.for({ network: NET });
    net.increment("spend_budget_nearing_total", { budget: "payer" });
    net.increment("spend_budget_nearing_total", { budget: "pay_to" });
    net.increment("spend_budget_nearing_total", {});
    const series = `spend_budget_nearing_total{network="${NET}"}`;
    expect(scrape().get(series)).toBe(0);
    net.increment("spend_budget_nearing_total", { budget: "global" });
    net.increment("spend_budget_nearing_total", { budget: "asset" });
    expect(scrape().get(series)).toBe(2);
    // A when on a dim still counts every value, written as the label.
    const reason = "settle_exact_stellar_fee_exceeds_maximum";
    net.increment("settlement_refused_after_verify_total", { stage: "check", reason });
    expect(
      scrape().get(
        `settlement_refused_after_verify_total{network="${NET}",stage="check",reason="${reason}"}`,
      ),
    ).toBe(1);
  });

  it("reports each distinct issue once, and at most 1000", () => {
    const { m, issues } = setup();
    for (let i = 0; i < 3; i++)
      m.increment("http_requests_total", { route: "/nope", status: "200" });
    expect(issues).toHaveLength(1);
    for (let i = 0; i < 1_100; i++)
      m.increment("http_requests_total", { route: `/r${i}`, status: "200" });
    expect(issues).toHaveLength(1_000);
  });

  it("keeps counting and scraping when the issue logger throws", () => {
    const m = prometheusMetrics({
      networks: [NET],
      onIssue: () => {
        throw new Error("logger down");
      },
    });
    const net = m.for({ network: NET });
    net.registerGauge("pool_queued", () => {
      throw new Error("read failed");
    });
    net.increment("settlement_outcomes_total", { result: "nope", replay: "false" });
    const text = m.render();
    expect(text).toContain(
      `settlement_outcomes_total{network="${NET}",result="other",replay="false"} 1`,
    );
    expect(text).not.toContain("pool_queued{");
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

  it("answers 500 when render throws, so the scrape fails instead of reading empty", async () => {
    const server = createServer(
      metricsListener(() => {
        throw new Error("render");
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`);
      expect(res.status).toBe(500);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
