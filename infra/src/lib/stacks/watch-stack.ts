// The off-server check (0027 decisions 7 and 27, ADR 0013): a Lambda in this account, every 5
// minutes, so it reads the fee account while the server is down, and root on the server can't
// stop it. This PR builds its balance section; the theft and secret-read sections follow. The
// alarms that read it are in the Alarms stack and find the function and the metric by name.
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import type { Construct } from "constructs";
import { NAMESPACE } from "../../watch/metric.js";
import { TARGETS_ENV } from "../../watch/targets.js";
import type { EnvironmentConfig } from "../config.js";
import { INFRA_ROOT, names } from "../names.js";

/** The bundle `build` writes (scripts/bundle-watch.mjs): synth never bundles. */
export const WATCH_BUNDLE_DIR = join(INFRA_ROOT, "dist", "lambdas", "watch");

export interface WatchStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class WatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WatchStackProps) {
    super(scope, id, props);
    const { config } = props;
    const functionName = names(config.envName).watchFunction;
    if (!existsSync(join(WATCH_BUNDLE_DIR, "index.mjs")))
      throw new Error(`No bundle in ${WATCH_BUNDLE_DIR}: run \`pnpm build\` in infra/ first.`);

    // validateConfig refuses a served network without its fee account or RPC.
    const watchTargets = config.networks.map((network) => ({
      network,
      feeAccount: config.feeAccounts[network]!,
      rpcUrl: config.watch.rpcUrls[network]!,
    }));

    const fn = new lambda.Function(this, "Watch", {
      functionName,
      description: `Reads the fee accounts every 5 minutes and publishes to ${NAMESPACE} (task 0027)`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(WATCH_BUNDLE_DIR),
      // Each read gives up after 30 s (src/watch/balance.ts); the rest is for the publish, well
      // inside the 5-minute interval, so two runs never overlap.
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      // One run at a time: a second, queued behind a slow one, would only repeat its points.
      reservedConcurrentExecutions: 1,
      // The next run, 5 minutes later, is the retry. A retry would count one failure as several in
      // `watch-errors`, and a run queued past its slot would stamp an old time.
      retryAttempts: 0,
      maxEventAge: cdk.Duration.seconds(60),
      environment: { [TARGETS_ENV]: JSON.stringify(watchTargets) },
      logGroup: new logs.LogGroup(this, "WatchLogGroup", {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // PutMetricData has no resource-level scoping: `*`, limited to the check's namespace.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": NAMESPACE } },
      }),
    );

    new scheduler.Schedule(this, "WatchSchedule", {
      scheduleName: functionName,
      description: "Runs the off-server check every 5 minutes (task 0027)",
      // On the clock, so each point lands in its own 5-minute period of the balance alarms.
      schedule: scheduler.ScheduleExpression.cron({ minute: "0/5", hour: "*" }),
      target: new targets.LambdaInvoke(fn, {
        retryAttempts: 0,
        input: scheduler.ScheduleTargetInput.fromObject({
          scheduledTime: scheduler.ContextAttribute.scheduledTime,
        }),
      }),
    });
  }
}
