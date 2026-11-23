// The monitoring VM's heartbeat and its identity (ADR 0011, "Heartbeat"; lore 0139).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { validateConfig } from "../src/lib/config.js";
import { INFRA_ROOT } from "../src/lib/names.js";
import { allOn, ofType, production, synth } from "./fixtures.js";

const prod = synth(production()).heartbeat;
const on = synth(allOn()).heartbeat;

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};
const role = ofType(on, "AWS::IAM::Role")[0]?.Properties as Record<string, unknown>;
const trust = (role["AssumeRolePolicyDocument"] as { Statement: Statement[] }).Statement;
const allowed = (role["Policies"] as { PolicyDocument: { Statement: Statement[] } }[]).flatMap(
  (p) => p.PolicyDocument.Statement,
);
const topicId = Object.entries(on.Resources).find(([, r]) => r.Type === "AWS::SNS::Topic")![0];
const alarmTopicArn = {
  "Fn::Join": [
    "",
    [
      "arn:",
      { Ref: "AWS::Partition" },
      ":sns:eu-central-1:",
      { Ref: "AWS::AccountId" },
      ":x402-production-alarms",
    ],
  ],
};

describe("the heartbeat", () => {
  test("has its topic whether the alarm is on or not, so the VM can publish before it is", () => {
    for (const t of [prod, on])
      expect(ofType(t, "AWS::SNS::Topic").map((r) => r.Properties["TopicName"])).toEqual([
        "x402-production-monitoring-heartbeat",
      ]);
  });

  test("makes no alarm while the group is off: missing data breaches, so it would fire at once", () => {
    expect(ofType(prod, "AWS::CloudWatch::Alarm")).toEqual([]);
  });

  test("fires after two silent 5-minute periods, missing data breaching, to the alarm topic", () => {
    const alarms = ofType(on, "AWS::CloudWatch::Alarm");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.Properties).toMatchObject({
      AlarmName: "x402-production-monitoring-heartbeat",
      Namespace: "AWS/SNS",
      MetricName: "NumberOfMessagesPublished",
      Dimensions: [{ Name: "TopicName", Value: { "Fn::GetAtt": [topicId, "TopicName"] } }],
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
      ComparisonOperator: "LessThanThreshold",
      Threshold: 1,
      TreatMissingData: "breaching",
      AlarmActions: [alarmTopicArn],
      OKActions: [alarmTopicArn],
    });
  });

  test("names its runbook section, which docs/monitoring.md has", () => {
    const doc = readFileSync(join(INFRA_ROOT, "..", "docs", "monitoring.md"), "utf8");
    expect(doc).toMatch(/^### monitoring-heartbeat$/m);
    const description = ofType(on, "AWS::CloudWatch::Alarm")[0]?.Properties["AlarmDescription"];
    expect(description).toMatch(/Runbook: docs\/monitoring\.md, monitoring-heartbeat\.$/);
  });
});

describe("the monitoring VM's role (ADR 0011, the VM's AWS identity)", () => {
  test("is the only IAM principal in the stack, with no managed policy", () => {
    expect(ofType(on, "AWS::IAM::Role")).toHaveLength(1);
    expect(ofType(on, "AWS::IAM::Policy")).toHaveLength(0);
    expect(ofType(on, "AWS::IAM::ManagedPolicy")).toHaveLength(0);
    expect(role).not.toHaveProperty("ManagedPolicyArns");
  });

  test("trusts Roles Anywhere only, for the VM's CN and this stack's anchor", () => {
    expect(trust).toHaveLength(1);
    expect(trust[0]).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "rolesanywhere.amazonaws.com" },
      Condition: {
        StringEquals: { "aws:PrincipalTag/x509Subject/CN": "x402-monitoring-vm-production" },
        ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": ["TrustAnchor", "TrustAnchorArn"] } },
      },
    });
  });

  test("only publishes, to the heartbeat and alarm topics, from the VM's IP", () => {
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({
      Effect: "Allow",
      Action: "sns:Publish",
      Resource: [{ Ref: topicId }, alarmTopicArn],
    });
    expect(Object.keys(allowed[0]?.Condition ?? {})).toEqual(["IpAddress"]);
    // The IP is an SSM parameter resolved at deploy, kept out of this public repo.
    const ssm = Object.entries(on.Parameters ?? {}).find(
      ([, p]) => (p as { Default?: string }).Default === "/x402/production/monitoring-vm-ip",
    );
    expect(ssm).toBeDefined();
    expect(JSON.stringify(allowed[0]?.Condition)).toContain(`{"Ref":"${ssm![0]}"}`);
  });
});

test("the VM's CN differs from the server agent's: one CA signs both", () => {
  const c = production();
  expect(() =>
    validateConfig({
      ...c,
      monitoringVm: { ...c.monitoringVm, certificateCn: c.logging.certificateCn },
    }),
  ).toThrow(/monitoringVm\.certificateCn.*must differ/);
});
