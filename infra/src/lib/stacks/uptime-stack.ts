// The uptime probe (0027 decision 5, ADR 0011 "Uptime"): a small Lambda in this region that reads
// /health through the public hostname every minute and publishes `ready` to `x402-watch`. It runs
// apart from #115's off-server check, so that check's dependencies (RPC, Horizon) can't stop it.
// The `uptime` alarm itself is in the Alarms stack and finds the metric by name.
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import { INFRA_ROOT, names } from "../names.js";

/** The probe's code, plain ES modules: no bundling, so synth stays offline and fast. */
export const UPTIME_PROBE_DIR = join(INFRA_ROOT, "lambdas", "uptime-probe");
/** The only namespace the probe may publish to. */
export const PROBE_NAMESPACE = "x402-watch";

export interface UptimeStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class UptimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UptimeStackProps) {
    super(scope, id, props);
    const { config } = props;
    const functionName = names(config.envName).uptimeProbe;

    const fn = new lambda.Function(this, "UptimeProbe", {
      functionName,
      description: `Reads ${config.uptime.url} every minute and publishes ready to ${PROBE_NAMESPACE} (task 0027)`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(UPTIME_PROBE_DIR),
      // The read gives up after 10 s (probe.mjs); the rest is for the publish.
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      // The next minute's run is the retry; a retry would only put two points in one minute.
      retryAttempts: 0,
      environment: { HEALTH_URL: config.uptime.url },
      logGroup: new logs.LogGroup(this, "UptimeProbeLogGroup", {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // PutMetricData has no resource-level scoping: `*`, limited to the probe's namespace.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": PROBE_NAMESPACE } },
      }),
    );

    new scheduler.Schedule(this, "UptimeProbeSchedule", {
      scheduleName: functionName,
      description: "Runs the uptime probe every minute (task 0027)",
      // At the start of every minute: a rate counts from the schedule's creation, and a run near a
      // minute's edge can then land in the next one, leaving a minute with no point (down).
      schedule: scheduler.ScheduleExpression.cron({ minute: "*", hour: "*" }),
      target: new targets.LambdaInvoke(fn, { retryAttempts: 0 }),
    });
  }
}
