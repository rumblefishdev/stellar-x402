// The app: stacks with no reference between them (0027 decision 27), each deployable alone.
import * as cdk from "aws-cdk-lib";
import { type EnvironmentConfig, validateConfig } from "./config.js";
import { stackPrefix } from "./names.js";
import { AlarmsStack } from "./stacks/alarms-stack.js";

export interface X402App {
  readonly app: cdk.App;
  readonly alarms: AlarmsStack;
}

export function createApp(config: EnvironmentConfig, app = new cdk.App()): X402App {
  validateConfig(config);
  const prefix = stackPrefix(config.envName);
  const props = (name: string) => ({
    // The region comes from the config, never from `--region`; the account from the credentials.
    env: { account: process.env["CDK_DEFAULT_ACCOUNT"], region: config.awsRegion },
    config,
    tags: { project: "stellar-x402", environment: config.envName },
    description: `stellar-x402 ${config.envName}: ${name} (task 0027)`,
  });

  return {
    app,
    alarms: new AlarmsStack(app, `${prefix}-Alarms`, props("Alarms")),
  };
}
