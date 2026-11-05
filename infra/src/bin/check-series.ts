#!/usr/bin/env node
// `make check-series GROUP=<group>`: before an alarm group goes on, its series must already reach
// CloudWatch (0027 decision 26, the spine's AD-6), or its alarms read OK on series that don't
// exist. Lists each series with `aws cloudwatch list-metrics` (the operator's SSO credentials).
// A series that is always written (a gauge, the sweeps' zero seed, a Lambda's own metrics, a log
// group's bytes) must have had data in the last 3 hours, or the check fails. A failure counter is
// written only when the failure happens, so it can't show data beforehand: it is listed, and it
// travels the same path as the group's gauges, its name and dimensions checked by the catalog.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as cdk from "aws-cdk-lib";
import type { SeriesRef } from "../lib/alarms/factory.js";
import {
  ALARM_GROUPS,
  type AlarmGroup,
  type EnvironmentConfig,
  validateConfig,
} from "../lib/config.js";
import {
  type ListMetricsOutput,
  alwaysWritten,
  listMetricsArgs,
  listsExactSeries,
} from "../lib/series.js";
import { AlarmsStack } from "../lib/stacks/alarms-stack.js";

const require = createRequire(import.meta.url);
const config = require("../../envs/production.json") as EnvironmentConfig;

const group = process.argv[2] as AlarmGroup | undefined;
if (!group || !(ALARM_GROUPS as readonly string[]).includes(group)) {
  console.error(`usage: check-series <group>, one of: ${ALARM_GROUPS.join(", ")}`);
  process.exit(2);
}

// The group alone, its unmeasured thresholds filled in only so that its alarms are built: this
// lists their series, it deploys nothing.
const only = Object.fromEntries(ALARM_GROUPS.map((g) => [g, g === group])) as Record<
  AlarmGroup,
  boolean
>;
const thresholds = Object.fromEntries(
  Object.entries(config.thresholds).map(([k, v]) => [k, v ?? 1]),
) as EnvironmentConfig["thresholds"];
const stack = new AlarmsStack(new cdk.App(), "CheckSeries", {
  config: { ...config, alarmGroups: only, thresholds },
});

const series = new Map<string, SeriesRef>();
for (const r of stack.alarms.records)
  for (const s of r.series) series.set(JSON.stringify([s.namespace, s.metricName, s.dims]), s);
if (series.size === 0) {
  console.error(
    `${group}: no alarm to check. A group that reads named mounts needs host.diskMounts or host.auditDiskMount first.`,
  );
  process.exit(1);
}

let missing = 0;
let checked = 0;
for (const s of series.values()) {
  const dims = Object.entries(s.dims);
  const label = `${s.namespace} ${s.metricName}${dims.length ? ` ${JSON.stringify(s.dims)}` : ""}`;
  if (!alwaysWritten(s)) {
    console.log(`event   ${label} (written only when it happens)`);
    continue;
  }
  checked++;
  const out = execFileSync("aws", listMetricsArgs(config.awsRegion, s), { encoding: "utf8" });
  const found = listsExactSeries(JSON.parse(out) as ListMetricsOutput, s.dims);
  if (!found) missing++;
  console.log(`${found ? "ok     " : "MISSING"} ${label}`);
}

// The series are there; the config may still lack what the group needs (a threshold, a mount).
let needs: string | undefined;
try {
  validateConfig({ ...config, alarmGroups: { ...config.alarmGroups, [group]: true } });
} catch (error) {
  needs = (error as Error).message.split("\n").slice(1).join("\n");
}

if (missing > 0)
  console.log(
    `${group}: ${missing} of ${checked} series written all the time have no data in the last 3 hours; keep the group off.`,
  );
else if (checked === 0)
  console.log(`${group}: its alarms read only series written when something fails.`);
else
  console.log(
    `${group}: the ${checked} series written all the time have data in the last 3 hours.`,
  );
if (needs) console.log(`Before it goes on, envs/${config.envName}.json needs:\n${needs}`);
else if (missing === 0) console.log(`${group} can go on (alarmGroups.${group}: true).`);
process.exit(missing === 0 && !needs ? 0 : 1);
