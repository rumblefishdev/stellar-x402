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

test("every selector is x402's", () => {
  for (const r of buildRules(allOn()).rules)
    for (const m of r.expr.matchAll(/\b([a-z_]+)\{([^}]*)\}/g))
      expect(m[2], `${r.alert}: ${m[1]}`).toContain('project="x402"');
});
