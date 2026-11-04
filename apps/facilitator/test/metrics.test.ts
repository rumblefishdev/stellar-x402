import { describe, expect, test } from "vitest";
import { memoryMetrics } from "../src/metrics.js";

describe("memoryMetrics", () => {
  test("increment then value counts", () => {
    const m = memoryMetrics();
    m.increment("fee_charged_stroops", { network: "testnet", state: "success" });
    m.increment("fee_charged_stroops", { network: "testnet", state: "success" });
    expect(m.value("fee_charged_stroops", { network: "testnet", state: "success" })).toBe(2);
  });

  test("increment by N sums the amount", () => {
    const m = memoryMetrics();
    const l = { network: "testnet", state: "success" };
    m.increment("fee_charged_stroops", l, 150);
    m.increment("fee_charged_stroops", l, 50);
    expect(m.value("fee_charged_stroops", l)).toBe(200);
  });

  test("registerGauge value is evaluated lazily", () => {
    const m = memoryMetrics();
    let v = 3;
    m.registerGauge("pool_queued", () => ({ value: v }));
    expect(m.value("pool_queued")).toBe(3);
    v = 7;
    expect(m.value("pool_queued")).toBe(7);
  });

  test("gauge labels from the callback are ignored by name lookup", () => {
    const m = memoryMetrics();
    m.registerGauge("pool_queued", () => ({ value: 1, labels: { network: "testnet" } }));
    expect(m.value("pool_queued")).toBe(1);
  });

  test("names are typed against the catalog", () => {
    const m = memoryMetrics();
    // @ts-expect-error a gauge is not a counter
    m.increment("pool_queued");
    // @ts-expect-error unknown name
    m.increment("no_such_metric");
    // @ts-expect-error a counter is not a gauge
    m.registerGauge("fee_charged_stroops", () => ({ value: 1 }));
    expect(true).toBe(true);
  });
});

describe("for({ network })", () => {
  const TESTNET = "stellar:testnet" as const;
  const PUBNET = "stellar:pubnet" as const;

  test("for() adds network to increments and gauges", () => {
    const m = memoryMetrics();
    const t = m.for({ network: TESTNET });
    t.increment("fee_charged_stroops", { state: "success" }, 100);
    t.increment("settlement_outcomes_total");
    t.registerGauge("pool_queued", () => ({ value: 4, labels: { pool: "settle" } }));
    m.for({ network: PUBNET }).registerGauge("pool_queued", () => ({ value: 9 }));

    expect(m.value("fee_charged_stroops", { network: TESTNET, state: "success" })).toBe(100);
    expect(m.value("settlement_outcomes_total", { network: TESTNET })).toBe(1);
    // Each network's gauge is its own series, read by the merged labels.
    expect(m.value("pool_queued", { network: TESTNET, pool: "settle" })).toBe(4);
    expect(m.value("pool_queued", { network: PUBNET })).toBe(9);
  });

  test("a child's network overrides a caller-supplied network label", () => {
    const m = memoryMetrics();
    const t = m.for({ network: TESTNET });
    t.increment("fee_charged_stroops", { network: PUBNET, state: "success" });
    t.registerGauge("pool_queued", () => ({ value: 2, labels: { network: PUBNET } }));

    expect(m.value("fee_charged_stroops", { network: TESTNET, state: "success" })).toBe(1);
    expect(m.value("fee_charged_stroops", { network: PUBNET, state: "success" })).toBe(0);
    expect(m.value("pool_queued", { network: TESTNET })).toBe(2);
    expect(m.value("pool_queued", { network: PUBNET })).toBe(0);
  });

  test("value() reads a child's count with the network label; a root increment has none", () => {
    const m = memoryMetrics();
    m.for({ network: TESTNET }).increment("fee_charged_stroops", { state: "success" });
    // The root is not scope-checked here (the writer enforces scope): it counts, keyed without network.
    m.increment("fee_charged_stroops", { state: "success" });
    m.increment("fee_charged_stroops", { state: "success" });

    expect(m.value("fee_charged_stroops", { network: TESTNET, state: "success" })).toBe(1);
    expect(m.value("fee_charged_stroops", { state: "success" })).toBe(2);
  });
});
