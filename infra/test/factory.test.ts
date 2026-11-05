import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { describe, expect, test } from "vitest";
import { AlarmFactory, describe as describeAlarm } from "../src/lib/alarms/factory.js";
import { ALARM_GROUPS, type AlarmGroup } from "../src/lib/config.js";
import { ofType, type TemplateJson } from "./fixtures.js";

const text = { what: "What happened.", next: "Do this.", noData: "Covered by x." };

function factory(groups: Partial<Record<AlarmGroup, boolean>> = { facilitator: true }) {
  const stack = new cdk.Stack(new cdk.App(), "T");
  const topic = new sns.Topic(stack, "Topic");
  const all = Object.fromEntries(ALARM_GROUPS.map((g) => [g, groups[g] ?? false]));
  const f = new AlarmFactory(stack, {
    envName: "production",
    groups: all as Record<AlarmGroup, boolean>,
    action: new cloudwatchActions.SnsAction(topic),
  });
  const alarms = () =>
    ofType(Template.fromStack(stack).toJSON() as TemplateJson, "AWS::CloudWatch::Alarm");
  return { f, alarms };
}

describe("series come only through the catalog", () => {
  test("a name the catalog doesn't declare fails synth", () => {
    const { f } = factory();
    expect(() =>
      f.event("x", {
        group: "facilitator",
        signal: { catalog: "cpu_used_percent" as never },
        description: text,
      }),
    ).toThrow(/not in the catalog/);
  });

  test("a network-scoped metric without its network fails synth", () => {
    const { f } = factory();
    expect(() =>
      f.event("x", {
        group: "facilitator",
        signal: { catalog: "signer_failures_total" },
        description: text,
      }),
    ).toThrow(/writes no set/);
  });

  test("a dimension value the catalog doesn't write fails synth", () => {
    const { f } = factory();
    expect(() =>
      f.event("x", {
        group: "facilitator",
        signal: { catalog: "http_requests_total", dims: { status: "404" } },
        description: text,
      }),
    ).toThrow(/written only when/);
  });

  test("an AWS metric off the list fails synth", () => {
    const { f } = factory();
    expect(() =>
      f.event("x", {
        group: "facilitator",
        signal: { aws: "AWS/Lambda", metric: "Throttles", dims: { FunctionName: "f" } },
        description: text,
      }),
    ).toThrow(/not one an alarm may read/);
  });

  test("the namespace comes from the catalog, and no Unit is set", () => {
    const { f, alarms } = factory();
    f.event("signer-failures", {
      group: "facilitator",
      network: "stellar:testnet",
      signal: { catalog: "signer_failures_total", dims: { network: "stellar:testnet" } },
      description: text,
    });
    const [a] = alarms();
    expect(a?.Properties).toMatchObject({
      Namespace: "x402-facilitator",
      MetricName: "signer_failures_total",
    });
    expect(a?.Properties).not.toHaveProperty("Unit");
  });
});

describe("shapes", () => {
  test("Event: 1 of 15 one-minute Sum periods, not breaching, no OK message", () => {
    const { f, alarms } = factory();
    f.event("history-gone", {
      group: "facilitator",
      network: "stellar:testnet",
      signal: { catalog: "settlement_history_gone_total", dims: { network: "stellar:testnet" } },
      description: text,
    });
    const [a] = alarms();
    expect(a?.Properties).toMatchObject({
      AlarmName: "x402-production-history-gone-testnet",
      Statistic: "Sum",
      Period: 60,
      EvaluationPeriods: 15,
      DatapointsToAlarm: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Threshold: 1,
      TreatMissingData: "notBreaching",
      ActionsEnabled: true,
    });
    expect(a?.Properties).not.toHaveProperty("OKActions");
  });

  test("Event as a count: a 5-minute Sum at the threshold, 1 of 3, no OK message", () => {
    const { f, alarms } = factory();
    f.event("pool-health", {
      group: "facilitator",
      network: "stellar:testnet",
      signal: {
        catalog: "pool_events_total",
        dims: { network: "stellar:testnet", type: "sequence-resync" },
      },
      periodMinutes: 5,
      periods: 3,
      threshold: 5,
      description: text,
    });
    expect(alarms()[0]?.Properties).toMatchObject({
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 1,
      Threshold: 5,
      TreatMissingData: "notBreaching",
    });
    expect(alarms()[0]?.Properties).not.toHaveProperty("OKActions");
  });

  test("Level: M of M, keeps its state without data, with an OK message", () => {
    const { f, alarms } = factory();
    f.level("pending", {
      group: "facilitator",
      network: "stellar:testnet",
      signal: { catalog: "settlement_oldest_open_seconds", dims: { network: "stellar:testnet" } },
      statistic: "Maximum",
      periodMinutes: 1,
      periods: 3,
      comparison: ">",
      threshold: 900,
      description: text,
    });
    expect(alarms()[0]?.Properties).toMatchObject({
      Statistic: "Maximum",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "ignore",
      OKActions: [expect.anything()],
    });
  });

  test("Silence over several series fires when any one of them goes silent", () => {
    const { f, alarms } = factory({ host: true });
    f.silence("telemetry-silent", {
      group: "host",
      signal: {
        each: {
          mem: { catalog: "mem_used_percent" },
          disk: { catalog: "disk_used_percent", dims: { path: "/" } },
        },
      },
      description: text,
    });
    const p = alarms()[0]?.Properties as Record<string, unknown>;
    const metrics = p["Metrics"] as {
      Id: string;
      Expression?: string;
      MetricStat?: { Stat: string };
    }[];
    expect(metrics.find((m) => m.Expression)?.Expression).toBe(
      "MIN([FILL(mem, 0), FILL(disk, 0)])",
    );
    expect(metrics.filter((m) => m.MetricStat).map((m) => [m.Id, m.MetricStat!.Stat])).toEqual([
      ["mem", "SampleCount"],
      ["disk", "SampleCount"],
    ]);
    expect(p).toMatchObject({ ComparisonOperator: "LessThanThreshold", Threshold: 1 });
  });

  test("Silence: FILL(SampleCount, 0) < 1 in 3 of 3 five-minute periods, breaching", () => {
    const { f, alarms } = factory({ host: true });
    f.silence("probe-silent", {
      group: "host",
      signal: { catalog: "host_probe_heartbeat" },
      description: text,
    });
    const p = alarms()[0]?.Properties as Record<string, unknown>;
    expect(p).toMatchObject({
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      ComparisonOperator: "LessThanThreshold",
      Threshold: 1,
      TreatMissingData: "breaching",
      OKActions: [expect.anything()],
    });
    const metrics = p["Metrics"] as {
      Expression?: string;
      MetricStat?: { Stat: string; Period: number };
    }[];
    expect(metrics.find((m) => m.Expression)?.Expression).toBe("FILL(m, 0)");
    expect(metrics.find((m) => m.MetricStat)?.MetricStat).toMatchObject({
      Stat: "SampleCount",
      Period: 300,
    });
  });

  test("a group that is off makes no alarm at all, rather than one without actions", () => {
    const { f, alarms } = factory({ facilitator: false });
    const made = f.event("history-gone", {
      group: "facilitator",
      network: "stellar:testnet",
      signal: { catalog: "settlement_history_gone_total", dims: { network: "stellar:testnet" } },
      description: text,
    });
    expect(made).toBeUndefined();
    expect(alarms()).toEqual([]);
    expect(f.records).toEqual([]);
  });

  test("a qualifier ends the name after the network", () => {
    const { f, alarms } = factory({ disk: true });
    f.level("disk", {
      group: "disk",
      qualifier: "root",
      signal: { catalog: "disk_used_percent", dims: { path: "/" } },
      statistic: "Maximum",
      periodMinutes: 5,
      periods: 3,
      comparison: ">",
      threshold: 80,
      description: text,
    });
    expect(alarms()[0]?.Properties["AlarmName"]).toBe("x402-production-disk-root");
  });
});

describe("descriptions", () => {
  test("say what happened, the next step, what covers the silence, and the runbook", () => {
    expect(describeAlarm("history-gone", text, "event")).toBe(
      "What happened. Next: Do this. No data: Covered by x. Runbook: docs/monitoring.md, history-gone.",
    );
  });

  test("say how a shape with an OK message re-arms (G-alarm-list, Shapes)", () => {
    expect(describeAlarm("pending", text, "level")).toBe(
      "What happened. Next: Do this. No data: Covered by x. OK once it is back within its threshold; the next crossing fires it again. Runbook: docs/monitoring.md, pending.",
    );
    expect(describeAlarm("probe-silent", text, "silence")).toContain("OK once points arrive again");
    expect(describeAlarm("http-500", text, "event")).not.toContain(" OK ");
  });

  test("refuse non-ASCII, which cdk diff would show as a change forever", () => {
    expect(() => describeAlarm("x", { ...text, what: "Fee — spent" })).toThrow(/ASCII/);
  });

  test("refuse more than CloudWatch's 1,024 characters", () => {
    expect(() => describeAlarm("x", { ...text, what: "a".repeat(1000) })).toThrow(/over 1024/);
  });
});
