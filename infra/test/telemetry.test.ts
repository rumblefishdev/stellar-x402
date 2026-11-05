import { describe, expect, test } from "vitest";
import { production, synth, ofType } from "./fixtures.js";

const { telemetry } = synth(production());
const role = ofType(telemetry, "AWS::IAM::Role")[0]?.Properties as Record<string, unknown>;
type Statement = {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};
const trust = (role["AssumeRolePolicyDocument"] as { Statement: Statement[] }).Statement;
const policies = role["Policies"] as { PolicyDocument: { Statement: Statement[] } }[];
const allowed = policies.flatMap((p) => p.PolicyDocument.Statement);
const actions = (s: Statement) => [s.Action].flat();

describe("the logging role (ADR 0011, decision 25)", () => {
  test("is the only IAM principal in the stack, with no managed policy", () => {
    expect(ofType(telemetry, "AWS::IAM::Role")).toHaveLength(1);
    expect(ofType(telemetry, "AWS::IAM::Policy")).toHaveLength(0);
    expect(ofType(telemetry, "AWS::IAM::ManagedPolicy")).toHaveLength(0);
    expect(role).not.toHaveProperty("ManagedPolicyArns");
  });

  test("trusts Roles Anywhere only, for our CN and our anchor", () => {
    expect(trust).toHaveLength(1);
    expect(trust[0]).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "rolesanywhere.amazonaws.com" },
      Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
      Condition: {
        StringEquals: { "aws:PrincipalTag/x509Subject/CN": "x402-cloudwatch-agent-production" },
        ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": ["TrustAnchor", "TrustAnchorArn"] } },
      },
    });
  });

  test("only writes: three logs actions on our two groups and PutMetricData for x402-host", () => {
    expect(allowed.every((s) => s.Effect === "Allow")).toBe(true);
    expect(allowed.flatMap(actions).sort()).toEqual([
      "cloudwatch:PutMetricData",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]);
    const logsStatement = allowed.find((s) => actions(s).includes("logs:PutLogEvents"));
    expect(logsStatement?.Resource).toEqual([
      { "Fn::GetAtt": [expect.stringMatching(/^AppLogGroup/), "Arn"] },
      { "Fn::GetAtt": [expect.stringMatching(/^MetricsLogGroup/), "Arn"] },
    ]);
    const metrics = allowed.find((s) => actions(s).includes("cloudwatch:PutMetricData"));
    expect(metrics?.Condition?.["StringEquals"]).toEqual({ "cloudwatch:namespace": "x402-host" });
  });

  test("needs the server's IP on every allowed action", () => {
    for (const s of allowed)
      expect(s.Condition?.["IpAddress"]?.["aws:SourceIp"]).toEqual({
        "Fn::Join": [
          "",
          [{ Ref: expect.stringMatching(/^SsmParameterValuex402productionserverip/) }, "/32"],
        ],
      });
    const params = telemetry.Parameters as Record<string, { Default: string }>;
    expect(Object.values(params).map((p) => p.Default)).toContain("/x402/production/server-ip");
  });

  test("never names a wildcard action or a resource beyond what PutMetricData needs", () => {
    for (const s of allowed) {
      expect(actions(s).every((a) => !a.includes("*"))).toBe(true);
      if (s.Resource === "*") expect(actions(s)).toEqual(["cloudwatch:PutMetricData"]);
    }
  });

  test("allows the 12-hour sessions #113's helper asks for, in the role and the profile", () => {
    expect(role["MaxSessionDuration"]).toBe(43_200);
    expect(ofType(telemetry, "AWS::RolesAnywhere::Profile")[0]?.Properties).toMatchObject({
      Enabled: true,
      DurationSeconds: 43_200,
      RoleArns: [{ "Fn::GetAtt": ["LoggingRole", "Arn"] }],
    });
  });
});

describe("the trust anchor", () => {
  test("holds the committed CA certificate", () => {
    const anchor = ofType(telemetry, "AWS::RolesAnywhere::TrustAnchor")[0]?.Properties;
    expect(anchor).toMatchObject({
      Enabled: true,
      Source: {
        SourceType: "CERTIFICATE_BUNDLE",
        SourceData: { X509CertificateData: expect.stringContaining("BEGIN CERTIFICATE") },
      },
    });
  });
});

describe("the log groups (decisions 18, 31)", () => {
  const groups = ofType(telemetry, "AWS::Logs::LogGroup") as unknown as {
    Properties: Record<string, unknown>;
    DeletionPolicy: string;
  }[];

  test("are the app and metrics groups, 30 days, Standard, kept unless a create rolls back", () => {
    expect(groups.map((g) => g.Properties["LogGroupName"]).sort()).toEqual([
      "/x402/production/app",
      "/x402/production/metrics",
    ]);
    for (const g of groups) {
      expect(g.Properties).toMatchObject({ RetentionInDays: 30, LogGroupClass: "STANDARD" });
      expect(g.DeletionPolicy).toBe("RetainExceptOnCreate");
    }
  });
});

test("outputs the ARNs the helper needs, with no export another stack could pin", () => {
  expect(Object.keys(telemetry.Outputs ?? {}).sort()).toEqual([
    "ProfileArn",
    "RoleArn",
    "TrustAnchorArn",
  ]);
  for (const o of Object.values(telemetry.Outputs ?? {})) expect(o).not.toHaveProperty("Export");
});
