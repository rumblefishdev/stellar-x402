import { readdirSync } from "node:fs";
import { byName as catalogEntry } from "@stellar-x402/metrics-catalog";
import { describe, expect, test } from "vitest";
import { METRICS, targetFromEnv } from "../lambdas/uptime-probe/probe.mjs";
import { UPTIME_PROBE_DIR, probeTargets } from "../src/lib/stacks/uptime-stack.js";
import { ofType, production, synth } from "./fixtures.js";

const URL = "https://x402-facilitator.sorobanscan.com/health";
const PORTAL_URL = "https://x402-portal.sorobanscan.com/health";
const HUB_URL = "https://sorobanscan.com/api/hub/me";

/** Each probe's function name, URL, metric and the fields a ready answer holds. */
const PROBES = [
  ["x402-production-uptime-probe", URL, "ready", { ready: true }],
  ["x402-production-portal-uptime-probe", PORTAL_URL, "portal_ready", { ready: true }],
  ["x402-production-hub-uptime-probe", HUB_URL, "hub_ready", { authenticated: false }],
] as const;

describe("the Uptime stack", () => {
  const { uptime } = synth(production());
  const functions = ofType(uptime, "AWS::Lambda::Function").map((f) => f.Properties);
  const fn = (name: string) => functions.find((f) => f["FunctionName"] === name);

  test("has one probe per target, and nothing else that runs", () => {
    expect(functions.map((f) => f["FunctionName"]).sort()).toEqual(PROBES.map((p) => p[0]).sort());
  });

  test.each(PROBES)(
    "runs %s on Node 22, arm64, reading %s for %s",
    (name, url, metric, expected) => {
      expect(fn(name)).toMatchObject({
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Handler: "index.handler",
        Timeout: 30,
        Environment: {
          Variables: { HEALTH_URL: url, METRIC: metric, EXPECT: JSON.stringify(expected) },
        },
      });
    },
  );

  test("sets each function's environment as the probe reads it, with a metric the catalog has", () => {
    for (const f of functions) {
      const env = (f["Environment"] as { Variables: Record<string, string> }).Variables;
      const target = targetFromEnv(env);
      expect(catalogEntry(target.metric)?.namespace).toBe("x402-watch");
    }
    expect(probeTargets(production()).map((t) => t.metric)).toEqual([...METRICS]);
  });

  test("keeps the facilitator's probe under the ids it was deployed with", () => {
    const ids = Object.entries(uptime.Resources)
      .filter(([, r]) =>
        ["AWS::Lambda::Function", "AWS::Logs::LogGroup", "AWS::Scheduler::Schedule"].includes(
          r.Type,
        ),
      )
      .map(([id]) => id.replace(/[0-9A-F]{8}$/, ""));
    expect(ids).toEqual(expect.arrayContaining(["UptimeProbe", "UptimeProbeLogGroup"]));
    expect(ids.some((id) => id.startsWith("UptimeProbeSchedule"))).toBe(true);
    const facilitator = Object.entries(uptime.Resources).find(
      ([id, r]) => r.Type === "AWS::Lambda::Function" && /^UptimeProbe[0-9A-F]{8}$/.test(id),
    );
    expect(facilitator?.[1].Properties["FunctionName"]).toBe("x402-production-uptime-probe");
  });

  test("ships only the handler and its logic, no tests", () => {
    expect(readdirSync(UPTIME_PROBE_DIR).sort()).toEqual(["index.mjs", "probe.mjs"]);
  });

  test("runs each at the start of every minute with no retries", () => {
    const schedules = ofType(uptime, "AWS::Scheduler::Schedule").map((s) => s.Properties);
    expect(schedules.map((s) => s["Name"]).sort()).toEqual(PROBES.map((p) => p[0]).sort());
    for (const s of schedules)
      expect(s).toMatchObject({
        ScheduleExpression: "cron(* * * * ? *)",
        State: "ENABLED",
        Target: { RetryPolicy: { MaximumRetryAttempts: 0 } },
      });
    const invokeConfigs = ofType(uptime, "AWS::Lambda::EventInvokeConfig");
    expect(invokeConfigs).toHaveLength(PROBES.length);
    for (const c of invokeConfigs) expect(c.Properties).toMatchObject({ MaximumRetryAttempts: 0 });
  });

  test("lets each publish only to x402-watch", () => {
    const statements = ofType(uptime, "AWS::IAM::Policy").flatMap(
      (p) => (p.Properties["PolicyDocument"] as { Statement: Record<string, unknown>[] }).Statement,
    );
    const put = statements.filter((s) => [s["Action"]].flat().includes("cloudwatch:PutMetricData"));
    expect(put).toEqual(
      PROBES.map(() =>
        expect.objectContaining({
          Resource: "*",
          Condition: { StringEquals: { "cloudwatch:namespace": "x402-watch" } },
        }),
      ),
    );
  });

  test("keeps each probe's own log 30 days", () => {
    const groups = ofType(uptime, "AWS::Logs::LogGroup").map((g) => g.Properties);
    expect(groups.map((g) => g["LogGroupName"]).sort()).toEqual(
      PROBES.map((p) => `/aws/lambda/${p[0]}`).sort(),
    );
    for (const g of groups) expect(g["RetentionInDays"]).toBe(30);
  });
});
