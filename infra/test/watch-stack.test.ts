import { describe, expect, test } from "vitest";
import { allOn, ofType, production, synth } from "./fixtures.js";

describe("the Watch stack", () => {
  const { watch } = synth(production());
  const fn = ofType(watch, "AWS::Lambda::Function")[0]?.Properties;

  test("runs the bundled check on Node 22, arm64, one run at a time", () => {
    expect(fn).toMatchObject({
      FunctionName: "x402-production-watch",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Timeout: 60,
      ReservedConcurrentExecutions: 1,
    });
  });

  test("hands the Lambda each network's fee account and RPC, from the infra config", () => {
    const env = (fn?.["Environment"] as { Variables: Record<string, string> }).Variables;
    expect(JSON.parse(env["WATCH_TARGETS"]!)).toEqual([
      {
        network: "stellar:testnet",
        feeAccount: "GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP",
        rpcUrl: "https://soroban-testnet.stellar.org",
      },
    ]);
  });

  test("reads every served network", () => {
    const { watch: both } = synth(allOn());
    const f = ofType(both, "AWS::Lambda::Function")[0]?.Properties;
    const env = (f?.["Environment"] as { Variables: Record<string, string> }).Variables;
    expect(
      (JSON.parse(env["WATCH_TARGETS"]!) as { network: string }[]).map((t) => t.network),
    ).toEqual(["stellar:testnet", "stellar:pubnet"]);
  });

  test("runs on the clock every 5 minutes, passing the scheduled time, with no retries", () => {
    expect(ofType(watch, "AWS::Scheduler::Schedule")[0]?.Properties).toMatchObject({
      ScheduleExpression: "cron(0/5 * * * ? *)",
      State: "ENABLED",
      Target: {
        RetryPolicy: { MaximumRetryAttempts: 0 },
        Input: JSON.stringify({ scheduledTime: "<aws.scheduler.scheduled-time>" }),
      },
    });
    expect(ofType(watch, "AWS::Lambda::EventInvokeConfig")[0]?.Properties).toMatchObject({
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 60,
    });
  });

  test("may only publish to x402-watch: no SSM, SNS or CloudTrail until those sections exist", () => {
    const statements = ofType(watch, "AWS::IAM::Policy")
      .filter((p) => JSON.stringify(p.Properties["Roles"]).includes("WatchServiceRole"))
      .flatMap(
        (p) =>
          (p.Properties["PolicyDocument"] as { Statement: Record<string, unknown>[] }).Statement,
      );
    expect(statements).toEqual([
      expect.objectContaining({
        Action: "cloudwatch:PutMetricData",
        Resource: "*",
        Condition: { StringEquals: { "cloudwatch:namespace": "x402-watch" } },
      }),
    ]);
  });

  test("keeps its own log 30 days", () => {
    expect(ofType(watch, "AWS::Logs::LogGroup")[0]?.Properties).toMatchObject({
      LogGroupName: "/aws/lambda/x402-production-watch",
      RetentionInDays: 30,
    });
  });
});
