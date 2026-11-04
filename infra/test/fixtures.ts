// What the tests build from: envs/production.json as committed, and the same with every group on
// and two networks, so that every alarm in the list is in the template.
import { createRequire } from "node:module";
import { Template } from "aws-cdk-lib/assertions";
import { type X402App, createApp } from "../src/lib/app.js";
import type { EnvironmentConfig } from "../src/lib/config.js";

const require = createRequire(import.meta.url);

export const production = (): EnvironmentConfig =>
  structuredClone(require("../envs/production.json") as EnvironmentConfig);

export type Resource = { Type: string; Properties: Record<string, unknown> };
export type TemplateJson = {
  Resources: Record<string, Resource>;
  Outputs?: Record<string, Record<string, unknown>>;
  Parameters?: Record<string, unknown>;
};

export const ofType = (t: TemplateJson, type: string): Resource[] =>
  Object.values(t.Resources).filter((r) => r.Type === type);

export function allOn(): EnvironmentConfig {
  const base = production();
  return {
    ...base,
    networks: ["stellar:testnet", "stellar:pubnet"],
    alarmGroups: Object.fromEntries(
      Object.keys(base.alarmGroups).map((g) => [g, true]),
    ) as EnvironmentConfig["alarmGroups"],
    feeAccounts: {
      ...base.feeAccounts,
      // A random key, for the template only: no account on pubnet is ours yet.
      "stellar:pubnet": "GCW5TAO7CB6FDNXLMZJZHQKKKGDBEAXMOGGYO2MCI2WXMKNGFWLLG7VY",
    },
    // The one mount the agent writes (the catalog's `path`), OpenBao's audit volume on it too.
    host: { diskMounts: ["/"], auditDiskMount: "/" },
    thresholds: {
      ...base.thresholds,
      diskUsedPercent: 80,
      memoryUsedPercent: 90,
      logVolumeBytesPerHour: 1_000_000_000,
    },
  };
}

const json = (s: Parameters<typeof Template.fromStack>[0]) =>
  Template.fromStack(s).toJSON() as TemplateJson;

export function synth(config: EnvironmentConfig) {
  const x: X402App = createApp(config);
  const alarms = json(x.alarms);
  const uptime = json(x.uptime);
  return { x, alarms, uptime, all: [alarms, uptime] };
}
