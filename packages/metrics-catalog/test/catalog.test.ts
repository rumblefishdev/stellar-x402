import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StellarNetwork } from "@stellar-x402/config";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  CATALOG,
  type CounterName,
  type DimSet,
  EMF_LINE_PREFIX,
  type GaugeName,
  type MetricDef,
  type MetricName,
  type Network,
  type NetworkCounterName,
  type NetworkGaugeName,
  type ProcessCounterName,
  type ProcessGaugeName,
  byName,
  eagerNames,
  effectiveSets,
  seriesDims,
} from "../src/index.js";

/** The facilitator metrics an Event-shape alarm reads (G-alarm-list), written eager-first. */
const EVENT_METRICS = [
  "spend_breaker_opened_total",
  "spend_budget_nearing_total",
  "settlement_record_failures_total",
  "spend_store_failures_total",
  "settlement_refused_after_verify_total",
  "settlement_history_gone_total",
  "settlement_landed_after_expired_total",
  "signer_failures_total",
  "spend_failure_attributed_total",
  "spend_commit_unmatched_total",
  "settlement_reconciled_total",
  "settlement_submit_failures_total",
  "settlement_hook_failures_total",
];

const ALL: readonly MetricDef[] = CATALOG;
const FACILITATOR = ALL.filter((m) => m.namespace === "x402-facilitator");
const setsOf = (m: MetricDef): readonly DimSet[] => m.sets;
const def = (name: string): MetricDef => {
  const found = byName(name);
  if (!found) throw new Error(`${name} is not in the catalog`);
  return found;
};

const FACILITATOR_SRC = fileURLToPath(new URL("../../../apps/facilitator/src", import.meta.url));
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );

describe("CATALOG", () => {
  test("names are unique per namespace", () => {
    for (const ns of ["x402-facilitator", "x402-host", "x402-watch"]) {
      const names = ALL.filter((m) => m.namespace === ns).map((m) => m.name);
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    }
    // byName is keyed by name alone, so a name must not repeat across namespaces either.
    expect(new Set(ALL.map((m) => m.name)).size).toBe(ALL.length);
  });

  test("every existing increment() name in apps/facilitator/src is a facilitator counter", () => {
    const names = new Set<string>();
    for (const file of sourceFiles(FACILITATOR_SRC))
      for (const match of readFileSync(file, "utf8").matchAll(/\bincrement\(\s*"([a-z0-9_]+)"/g))
        names.add(match[1] as string);
    expect(names.size).toBeGreaterThan(30);
    for (const name of names) {
      const m = byName(name);
      expect(m, name).toBeDefined();
      expect(m?.namespace, name).toBe("x402-facilitator");
      expect(m?.kind, name).toBe("counter");
    }
  });

  test("process-scoped metrics never list network; network is never listed explicitly in sets", () => {
    for (const m of ALL) {
      expect(["network", "process"]).toContain(m.scope);
      for (const set of setsOf(m)) {
        expect(set.dims, m.name).not.toContain("network");
        expect(Object.keys(set.when ?? {}), m.name).not.toContain("network");
      }
      expect(Object.keys(m.values ?? {}), m.name).not.toContain("network");
      expect(setsOf(m).length, m.name).toBeGreaterThan(0);
    }
  });

  test("http_requests_total: sets [route] and [status] when status=500, scope process", () => {
    const m = def("http_requests_total");
    expect(m.scope).toBe("process");
    expect(m.sets).toEqual([{ dims: ["route"] }, { dims: ["status"], when: { status: ["500"] } }]);
    expect(m.values?.route).toEqual([
      "/verify",
      "/settle",
      "/supported",
      "/health",
      "/discovery",
      "other",
    ]);
  });

  test("spend_budget_nearing_total: one set without budget, when budget in asset/other/global", () => {
    const m = def("spend_budget_nearing_total");
    expect(m.scope).toBe("network");
    expect(m.sets).toEqual([{ dims: [], when: { budget: ["asset", "other", "global"] } }]);
  });

  test("settlement outcomes and sweeps are billed by result and outcome", () => {
    const outcomes = def("settlement_outcomes_total");
    expect(outcomes.sets).toEqual([{ dims: ["result"] }]);
    expect(outcomes.values?.result).toEqual(["success", "error", "other"]);
    const sweeps = def("settlement_sweeps_total");
    expect(sweeps.sets).toEqual([{ dims: ["outcome"] }]);
    expect(sweeps.values?.outcome).toEqual(["listed", "failed", "other"]);
  });

  test("every facilitator set dim has a closed values list that includes 'other'", () => {
    for (const m of FACILITATOR)
      for (const set of setsOf(m)) {
        for (const dim of set.dims) {
          const values = m.values?.[dim];
          expect(values, `${m.name}.${dim}`).toBeDefined();
          expect(values, `${m.name}.${dim}`).toContain("other");
        }
        // A condition on a billed dim can only match a value its closed list allows.
        for (const [label, matches] of Object.entries(set.when ?? {}))
          if (set.dims.includes(label))
            for (const v of matches) expect(m.values?.[label], `${m.name}.${label}`).toContain(v);
      }
  });

  test("every set dim of every metric has a closed values list", () => {
    for (const m of ALL)
      for (const set of setsOf(m))
        for (const dim of set.dims) expect(m.values?.[dim], `${m.name}.${dim}`).toBeDefined();
  });

  test("x402-host metrics are process-scoped; disk_used_percent's path is the one mount, /", () => {
    for (const m of ALL.filter((x) => x.namespace === "x402-host")) expect(m.scope).toBe("process");
    const disk = def("disk_used_percent");
    expect(disk.sets).toEqual([{ dims: ["path"] }]);
    expect(disk.values?.path).toEqual(["/"]);
    expect(seriesDims("disk_used_percent", { path: "/" }).ok).toBe(true);
    expect(seriesDims("disk_used_percent", { path: "/boot" }).ok).toBe(false);
  });

  test("x402-watch scopes", () => {
    const scopes = Object.fromEntries(
      ALL.filter((m) => m.namespace === "x402-watch").map((m) => [m.name, m.scope]),
    );
    expect(scopes).toEqual({
      ready: "process",
      spendable_stroops: "network",
      account_state_mismatches: "network",
      account_effects_unexpected: "network",
      backup_secret_reads: "process",
      upstream_files_changed: "process",
    });
  });

  test("emit is eager-first for exactly the Event-alarm metrics", () => {
    expect(eagerNames).toEqual(new Set(EVENT_METRICS));
    for (const m of ALL) expect(["eager-first", "aggregated"]).toContain(m.emit);
  });

  test("units are one of the allowed EMF units", () => {
    for (const m of ALL) {
      expect(["counter", "gauge"]).toContain(m.kind);
      expect(["Count", "Seconds", "None", "Percent"]).toContain(m.unit);
    }
  });

  test("no dim or values key is payer/payTo", () => {
    for (const m of ALL) {
      const keys = [
        ...setsOf(m).flatMap((s) => [...s.dims, ...Object.keys(s.when ?? {})]),
        ...Object.keys(m.values ?? {}),
        ...(m.fields ?? []),
      ];
      for (const k of keys) expect(["payer", "payTo", "pay_to"], m.name).not.toContain(k);
    }
  });

  test("a log field is in no set and no values list, and never network (decision 57)", () => {
    for (const m of ALL) {
      const billed = new Set([
        ...setsOf(m).flatMap((s) => [...s.dims, ...Object.keys(s.when ?? {})]),
        ...Object.keys(m.values ?? {}),
        "network",
      ]);
      for (const field of m.fields ?? [])
        expect(billed.has(field), `${m.name}.${field}`).toBe(false);
      expect(new Set(m.fields ?? []).size, m.name).toBe((m.fields ?? []).length);
    }
  });

  test("byName returns undefined for an unknown name", () => {
    expect(byName("no_such_metric_total")).toBeUndefined();
    expect(byName("settlement_outcomes_total")?.name).toBe("settlement_outcomes_total");
  });

  test("EMF_LINE_PREFIX is '{\"_aws\":'", () => {
    expect(EMF_LINE_PREFIX).toBe('{"_aws":');
  });

  // G-metrics' tables, name -> [kind, unit, scope]: nothing missing, nothing extra.
  test("every metric of G-metrics, with its kind, unit and scope, and nothing else", () => {
    const c = "counter";
    const g = "gauge";
    const net = "network";
    const proc = "process";
    const facNetCounters = [
      "settlement_outcomes_total",
      "settlement_refused_after_verify_total",
      "settlement_record_failures_total",
      "settlement_history_gone_total",
      "settlement_landed_after_expired_total",
      "settlement_rewrapped_total",
      "signer_failures_total",
      "pool_events_total",
      "settlement_uncertain_total",
      "settlement_submit_failures_total",
      "settlement_budget_exhausted_total",
      "settlement_reconciled_total",
      "settlement_reopened_total",
      "settlement_lease_fenced_total",
      "settlement_hook_failures_total",
      "settlement_already_settled_total",
      "settlement_nonce_reuse_total",
      "lease_changes_total",
      "spend_breaker_opened_total",
      "spend_budget_nearing_total",
      "spend_failure_attributed_total",
      "spend_commit_unmatched_total",
      "spend_store_failures_total",
      "spend_refused_total",
      "balance_read_failures_total",
      "settlement_sweeps_total",
    ];
    const facProcCounters = [
      "http_requests_total",
      "store_prune_failures_total",
      "catalog_internal_errors_total",
      "catalog_rejections_total",
      "catalog_upsert_failures_total",
      "catalog_upserts_total",
      "catalog_route_template_ignored_total",
      "discovery_unknown_params_total",
    ];
    const expected: Record<string, [string, string, string]> = {
      ...Object.fromEntries(facNetCounters.map((n) => [n, [c, "Count", net]])),
      ...Object.fromEntries(facProcCounters.map((n) => [n, [c, "Count", proc]])),
      fee_charged_stroops: [c, "None", net],
      settlement_oldest_open_seconds: [g, "Seconds", net],
      pool_queued: [g, "Count", net],
      pool_quarantined: [g, "Count", net],
      rpc_on_fallback: [g, "None", net],
      rpc_stalled_seconds: [g, "Seconds", net],
      balance_reading_age_seconds: [g, "Seconds", net],
      channel_longest_hold_seconds: [g, "Seconds", net],
      openbao_up: [g, "None", proc],
      wal_failing: [g, "None", proc],
      wal_last_archived_age_seconds: [g, "Seconds", proc],
      backup_age_seconds: [g, "Seconds", proc],
      snapshot_age_seconds: [g, "Seconds", proc],
      certificate_days_left: [g, "None", proc],
      host_probe_heartbeat: [g, "None", proc],
      credentials_age_seconds: [g, "Seconds", proc],
      watchdog_restarts_total: [c, "Count", proc],
      facilitator_failures_total: [c, "Count", proc],
      mem_used_percent: [g, "Percent", proc],
      disk_used_percent: [g, "Percent", proc],
      ready: [g, "None", proc],
      spendable_stroops: [g, "None", net],
      account_state_mismatches: [g, "Count", net],
      account_effects_unexpected: [c, "Count", net],
      backup_secret_reads: [c, "Count", proc],
      upstream_files_changed: [g, "Count", proc],
    };
    expect(Object.fromEntries(ALL.map((m) => [m.name, [m.kind, m.unit, m.scope]]))).toEqual(
      expected,
    );
    // Decision 20: no CPU metric.
    expect(ALL.filter((m) => /cpu/i.test(m.name))).toEqual([]);
  });

  test("the sets billed for some values only (decision 15)", () => {
    expect(def("settlement_refused_after_verify_total").sets).toEqual([
      { dims: ["stage"], when: { stage: ["pool"] } },
    ]);
    expect(def("pool_events_total").sets).toEqual([
      { dims: [] },
      { dims: ["type"], when: { type: ["sequence-resync"] } },
    ]);
    expect(def("spend_failure_attributed_total").sets).toEqual([
      { dims: ["fault"], when: { fault: ["ours"] } },
    ]);
    expect(def("spend_breaker_opened_total").sets).toEqual([{ dims: ["breaker"] }]);
    expect(def("settlement_reconciled_total").sets).toEqual([
      { dims: [] },
      { dims: ["state"], when: { state: ["expired"] } },
    ]);
    // Every other metric is one plain set.
    const split = [
      "settlement_outcomes_total",
      "settlement_refused_after_verify_total",
      "pool_events_total",
      "spend_budget_nearing_total",
      "spend_failure_attributed_total",
      "http_requests_total",
      "settlement_sweeps_total",
      "settlement_reconciled_total",
      "spend_breaker_opened_total",
      "disk_used_percent",
    ];
    for (const m of ALL.filter((x) => !split.includes(x.name)))
      expect(m.sets, m.name).toEqual([{ dims: [] }]);
  });
});

describe("scope-split name types", () => {
  test("resolve to the facilitator names of their kind and scope", () => {
    expectTypeOf<ProcessCounterName>().toEqualTypeOf<
      | "http_requests_total"
      | "store_prune_failures_total"
      | "catalog_internal_errors_total"
      | "catalog_rejections_total"
      | "catalog_upsert_failures_total"
      | "catalog_upserts_total"
      | "catalog_route_template_ignored_total"
      | "discovery_unknown_params_total"
    >();
    expectTypeOf<NetworkGaugeName>().toEqualTypeOf<
      | "settlement_oldest_open_seconds"
      | "pool_queued"
      | "pool_quarantined"
      | "rpc_on_fallback"
      | "rpc_stalled_seconds"
      | "balance_reading_age_seconds"
      | "channel_longest_hold_seconds"
    >();
    expectTypeOf<ProcessGaugeName>().toBeNever();
    expectTypeOf<NetworkCounterName>().toEqualTypeOf<Exclude<CounterName, ProcessCounterName>>();
    expectTypeOf<"settlement_outcomes_total">().toExtend<NetworkCounterName>();
    expectTypeOf<"http_requests_total">().not.toExtend<NetworkCounterName>();
    expectTypeOf<"openbao_up">().not.toExtend<GaugeName>();
    expectTypeOf<Network>().toEqualTypeOf<StellarNetwork>();
  });
});

describe("effectiveSets", () => {
  test("a network-scoped metric gets network first in every set", () => {
    expect(effectiveSets(def("settlement_sweeps_total"))).toEqual([
      { dims: ["network", "outcome"] },
    ]);
    expect(effectiveSets(def("signer_failures_total"))).toEqual([{ dims: ["network"] }]);
    expect(effectiveSets(def("spend_budget_nearing_total"))).toEqual([
      { dims: ["network"], when: { budget: ["asset", "other", "global"] } },
    ]);
  });

  test("a process-scoped metric keeps its sets as declared", () => {
    expect(effectiveSets(def("store_prune_failures_total"))).toEqual([{ dims: [] }]);
    expect(effectiveSets(def("disk_used_percent"))).toEqual([{ dims: ["path"] }]);
  });

  test("http_requests_total has two sets, the second only for a 500", () => {
    expect(effectiveSets(def("http_requests_total"))).toEqual([
      { dims: ["route"] },
      { dims: ["status"], when: { status: ["500"] } },
    ]);
  });
});

describe("seriesDims", () => {
  const ok = (name: MetricName) => ({
    ok: true,
    namespace: def(name).namespace,
  });

  test("accepts a set's dims whose when holds", () => {
    expect(seriesDims("http_requests_total", { status: "500" })).toEqual(ok("http_requests_total"));
    expect(seriesDims("http_requests_total", { route: "/settle" })).toEqual(
      ok("http_requests_total"),
    );
  });

  test("rejects a value the set's when doesn't hold", () => {
    expect(seriesDims("http_requests_total", { status: "200" })).toMatchObject({ ok: false });
  });

  test("rejects a value outside a closed dim's values", () => {
    expect(seriesDims("http_requests_total", { route: "/x" })).toMatchObject({ ok: false });
  });

  test("accepts a network-scoped series with a STELLAR_NETWORKS value", () => {
    expect(
      seriesDims("settlement_sweeps_total", { network: "stellar:testnet", outcome: "listed" }),
    ).toEqual({ ok: true, namespace: "x402-facilitator" });
    expect(
      seriesDims("settlement_sweeps_total", { network: "stellar:mainnet", outcome: "listed" }),
    ).toMatchObject({ ok: false });
  });

  test("rejects a network-scoped metric without network, and a process one with it", () => {
    expect(seriesDims("settlement_sweeps_total", { outcome: "listed" })).toMatchObject({
      ok: false,
    });
    expect(seriesDims("signer_failures_total", {})).toMatchObject({ ok: false });
    expect(seriesDims("store_prune_failures_total", { network: "stellar:testnet" })).toMatchObject({
      ok: false,
    });
  });

  test("rejects dims that are a set's plus more", () => {
    expect(
      seriesDims("settlement_sweeps_total", {
        network: "stellar:testnet",
        outcome: "listed",
        result: "success",
      }),
    ).toMatchObject({ ok: false });
  });

  test("a when on a label that is no dim leaves the series to the lines", () => {
    // `budget` picks which lines write the series; the series itself is network alone.
    expect(seriesDims("spend_budget_nearing_total", { network: "stellar:pubnet" })).toEqual(
      ok("spend_budget_nearing_total"),
    );
  });

  test("a host dim takes only its listed values, never an empty one", () => {
    expect(seriesDims("disk_used_percent", { path: "/" })).toEqual(ok("disk_used_percent"));
    expect(seriesDims("disk_used_percent", { path: "/data" })).toMatchObject({ ok: false });
    expect(seriesDims("disk_used_percent", { path: "" })).toMatchObject({ ok: false });
  });

  test("rejects an unknown name, with the reason", () => {
    const res = seriesDims("no_such_metric_total" as MetricName, {});
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.why).toContain("no_such_metric_total");
  });
});
