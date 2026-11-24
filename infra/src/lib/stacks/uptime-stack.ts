// The uptime probes (0027 decision 5, ADR 0011 "Uptime"; 0106 decision 21): small Lambdas in this
// region, one per target, each reading one URL through its public hostname every minute and
// publishing one metric to `x402-watch`. They run apart from #115's off-server check, so that
// check's dependencies (RPC, Horizon) can't stop them, and apart from each other, so one target's
// probe failing can't silence another's. Their alarms are in the Alarms stack and find each
// metric by name.
import { join } from "node:path";
import type { MetricName } from "@stellar-x402/metrics-catalog";
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
/** The only namespace the probes may publish to. */
export const PROBE_NAMESPACE = "x402-watch";

/** What one probe reads and publishes: the same code, its own function (0106 decision 21). */
export interface ProbeTarget {
  /** Starts the construct ids; empty for the facilitator's, so its resources keep their ids. */
  readonly idPrefix: string;
  readonly functionName: string;
  readonly url: string;
  readonly metric: Extract<MetricName, "ready" | "portal_ready" | "hub_ready">;
  /** The fields a ready answer's JSON body holds, each compared with `===`. */
  readonly expect: Readonly<Record<string, string | number | boolean | null>>;
  /** The task that added it, for the function's description. */
  readonly task: string;
}

/**
 * The three targets. The facilitator's and the portal backend's `/health` answer
 * `{"ready": true}` when they can serve. The API hub's backend is read end to end through the
 * explorer's CloudFront distribution, at `/api/hub/me`: unauthenticated, it answers 200 with
 * `{"authenticated": false}`, while that distribution answers a path it doesn't route with a
 * redirect, or 200 or 403 with the explorer's HTML, so the status alone proves nothing.
 */
export function probeTargets(config: EnvironmentConfig): readonly ProbeTarget[] {
  const n = names(config.envName);
  return [
    {
      idPrefix: "",
      functionName: n.uptimeProbe,
      url: config.uptime.url,
      metric: "ready",
      expect: { ready: true },
      task: "0027",
    },
    {
      idPrefix: "Portal",
      functionName: n.portalUptimeProbe,
      url: config.uptime.portalUrl,
      metric: "portal_ready",
      expect: { ready: true },
      task: "0106",
    },
    {
      idPrefix: "Hub",
      functionName: n.hubUptimeProbe,
      url: config.uptime.hubUrl,
      metric: "hub_ready",
      expect: { authenticated: false },
      task: "0106",
    },
  ];
}

export interface UptimeStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class UptimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UptimeStackProps) {
    super(scope, id, props);
    const code = lambda.Code.fromAsset(UPTIME_PROBE_DIR);
    for (const target of probeTargets(props.config)) this.probe(target, code);
  }

  private probe(t: ProbeTarget, code: lambda.Code): void {
    const id = (name: string) => `${t.idPrefix}${name}`;
    const fn = new lambda.Function(this, id("UptimeProbe"), {
      functionName: t.functionName,
      description: `Reads ${t.url} every minute and publishes ${t.metric} to ${PROBE_NAMESPACE} (task ${t.task})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code,
      // The read gives up after 10 s (probe.mjs); the rest is for the publish.
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      // The next minute's run is the retry; a retry would only put two points in one minute.
      retryAttempts: 0,
      environment: {
        HEALTH_URL: t.url,
        METRIC: t.metric,
        EXPECT: JSON.stringify(t.expect),
      },
      logGroup: new logs.LogGroup(this, id("UptimeProbeLogGroup"), {
        logGroupName: `/aws/lambda/${t.functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // PutMetricData has no resource-level scoping: `*`, limited to the probes' namespace.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": PROBE_NAMESPACE } },
      }),
    );

    new scheduler.Schedule(this, id("UptimeProbeSchedule"), {
      scheduleName: t.functionName,
      description: `Runs ${t.functionName} every minute (task ${t.task})`,
      // At the start of every minute: a rate counts from the schedule's creation, and a run near a
      // minute's edge can then land in the next one, leaving a minute with no point (down).
      schedule: scheduler.ScheduleExpression.cron({ minute: "*", hour: "*" }),
      target: new targets.LambdaInvoke(fn, { retryAttempts: 0 }),
    });
  }
}
