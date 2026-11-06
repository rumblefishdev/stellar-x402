import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { UPTIME_PROBE_DIR } from "../src/lib/stacks/uptime-stack.js";
import { ofType, production, synth } from "./fixtures.js";

const URL = "https://x402-facilitator.sorobanscan.com/health";

describe("the Uptime stack", () => {
  const { uptime } = synth(production());
  const fn = ofType(uptime, "AWS::Lambda::Function")[0]?.Properties;

  test("runs the probe on Node 22, arm64, reading the configured URL", () => {
    expect(fn).toMatchObject({
      FunctionName: "x402-production-uptime-probe",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 30,
      Environment: { Variables: { HEALTH_URL: URL } },
    });
  });

  test("ships only the handler and its logic, no tests", () => {
    expect(readdirSync(UPTIME_PROBE_DIR).sort()).toEqual(["index.mjs", "probe.mjs"]);
  });

  test("runs at the start of every minute with no retries", () => {
    expect(ofType(uptime, "AWS::Scheduler::Schedule")[0]?.Properties).toMatchObject({
      ScheduleExpression: "cron(* * * * ? *)",
      State: "ENABLED",
      Target: { RetryPolicy: { MaximumRetryAttempts: 0 } },
    });
    expect(ofType(uptime, "AWS::Lambda::EventInvokeConfig")[0]?.Properties).toMatchObject({
      MaximumRetryAttempts: 0,
    });
  });

  test("may publish only to x402-watch", () => {
    const statements = ofType(uptime, "AWS::IAM::Policy").flatMap(
      (p) => (p.Properties["PolicyDocument"] as { Statement: Record<string, unknown>[] }).Statement,
    );
    const put = statements.filter((s) => [s["Action"]].flat().includes("cloudwatch:PutMetricData"));
    expect(put).toEqual([
      expect.objectContaining({
        Resource: "*",
        Condition: { StringEquals: { "cloudwatch:namespace": "x402-watch" } },
      }),
    ]);
  });

  test("keeps its own log 30 days", () => {
    expect(ofType(uptime, "AWS::Logs::LogGroup")[0]?.Properties).toMatchObject({
      LogGroupName: "/aws/lambda/x402-production-uptime-probe",
      RetentionInDays: 30,
    });
  });
});
