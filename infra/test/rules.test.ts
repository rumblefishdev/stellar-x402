// The monitoring VM's rules against the alarm rows they come from (lore 0139 step 6).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { INFRA_ROOT } from "../src/lib/names.js";
import { buildRules, ruleFile } from "../src/lib/rules.js";
import { allOn, production, synth } from "./fixtures.js";

const checksOf = (c = allOn()) => {
  const { rules, skipped } = buildRules(c);
  const branches = rules.flatMap((r) =>
    [...r.expr.matchAll(/"check", "([a-z0-9-]+)"/g)].map((m) => m[1]!),
  );
  return {
    rules,
    skipped,
    made: new Set([...rules.flatMap((r) => r.labels.check ?? []), ...branches]),
  };
};

test("the committed rule file is what `make rules` writes", () => {
  const committed = readFileSync(
    join(INFRA_ROOT, "../deploy/metrics/rules/x402-production.yml"),
    "utf8",
  );
  expect(committed).toBe(ruleFile(production()));
});

test("every CloudWatch alarm makes a rule or says why not", () => {
  const { made, skipped } = checksOf();
  const why = new Set(skipped.map((s) => s.check));
  const rows = synth(allOn()).x.alarms.alarms.records.map((r) =>
    r.alarmName.replace(/^x402-production-/, "").replace(/-(testnet|pubnet)(?=-|$)/, ""),
  );
  expect(rows.length).toBeGreaterThan(40);
  expect(rows.filter((row) => !made.has(row) && !why.has(row))).toEqual([]);
});

test("pubnet adds alert instances, not rules", () => {
  const one = { ...allOn(), networks: ["stellar:testnet" as const] };
  const two = buildRules(allOn()).rules;
  expect(two.map((r) => r.alert)).toEqual(buildRules(one).rules.map((r) => r.alert));
  // Only a stamp's absent() names a network: it can't tell one network's from another's otherwise.
  for (const r of two)
    for (const m of r.expr.matchAll(/network="[^"]+"/g))
      expect(r.expr.slice(0, m.index)).toMatch(/absent\([a-z_]+\{[^}]*$/);
  for (const r of two) expect(r.annotations.description).not.toMatch(/stellar:(testnet|pubnet)/);
});

test("every Event row is a branch of one rule, and the rule sets no check of its own", () => {
  const { rules } = checksOf();
  const events = rules.filter((r) => r.labels.shape === "event");
  expect(events.map((r) => r.alert)).toEqual(["x402-event"]);
  expect(events[0]!.labels.check).toBeUndefined();
  for (const check of ["http-500", "store-outage", "breaker-opened-pay-to", "facilitator-failed"])
    expect(events[0]!.expr).toContain(`"check", "${check}"`);
  expect(events[0]!.annotations.description).toContain('eq $labels.check "http-500"');
});

test("an Event also fires on a facilitator counter above 0 in a process started in its window", () => {
  // Karol's point 4 on #211; event-restart-and-pool-health.test.yml shows when.
  const expr = checksOf().rules.find((r) => r.alert === "x402-event")!.expr;
  const branch = (check: string) =>
    expr.split("label_replace(label_replace(").find((b) => b.includes(`"check", "${check}"`))!;
  for (const check of ["history-gone", "signer-failures", "http-500"])
    expect(branch(check), check).toContain("facilitator_started_timestamp_seconds");
  // The host probe's counters keep their totals across restarts, and a count since the start
  // isn't pool-health's 5 in one period.
  for (const check of ["watchdog-restart", "facilitator-failed", "pool-health"])
    expect(branch(check), check).not.toContain("facilitator_started_timestamp_seconds");
});

test("no rule says CloudWatch's no-data behaviour or names its silences", () => {
  // A rule resolves once its series goes stale (Karol's point 2 on #211), and probe-silent and
  // telemetry-silent are textfile-stale and server-silent here.
  for (const r of buildRules(allOn()).rules)
    for (const cw of ["Keeps its state", "probe-silent", "telemetry-silent"])
      expect(r.annotations.description, r.alert).not.toContain(cw);
});

test("the checks that would page on mainnet are critical, every other one a warning", () => {
  const severity = new Map<string, string>();
  for (const r of buildRules(allOn()).rules) {
    if (r.labels.check) severity.set(r.labels.check, r.labels.severity ?? "none");
    for (const m of r.expr.matchAll(
      /label_replace\(label_replace\(.*?, "check", "([a-z0-9-]+)", "", ""\), "severity", "([a-z]+)", "", ""\)/g,
    ))
      severity.set(m[1]!, m[2]!);
  }
  // 0139 decision 1: ADR 0011's money alerts, then 0138's D1 and D2 defaults.
  const critical = [
    "pending",
    "breaker-opened-payer",
    "breaker-opened-pay-to",
    "breaker-opened-asset",
    "budget-nearing",
    "sweeps-stopped",
    "landed-after-expired",
    "commit-unmatched",
    "facilitator-silent",
    "gauge-stale",
  ];
  expect(
    [...severity]
      .filter(([, s]) => s === "critical")
      .map(([c]) => c)
      .sort(),
  ).toEqual([...critical].sort());
  expect([...severity.values()].every((s) => s === "critical" || s === "warning")).toBe(true);
  // The Event rule sets neither: its label would override every branch's.
  const event = buildRules(allOn()).rules.find((r) => r.alert === "x402-event")!;
  expect(event.labels.severity).toBeUndefined();
  // Every branch that sets `check` sets `severity` too (Karol's re-review of #211): a branch that
  // lost it would match neither the regex above nor be counted here.
  const branches = [...event.expr.matchAll(/"check", "([a-z0-9-]+)"/g)].map((m) => m[1]!);
  expect(branches.length).toBeGreaterThan(0);
  expect([...event.expr.matchAll(/"severity", "/g)]).toHaveLength(branches.length);
  expect(branches.filter((c) => !severity.has(c))).toEqual([]);
});

test("every selector is x402's, and so is every alert", () => {
  for (const r of buildRules(allOn()).rules) {
    for (const m of r.expr.matchAll(/\b([a-z_]+)\{([^}]*)\}/g))
      expect(m[2], `${r.alert}: ${m[1]}`).toContain('project="x402"');
    // An aggregation drops the series' label, so the rule sets it for the VM's routes.
    expect(r.labels.project, r.alert).toBe("x402");
  }
});
