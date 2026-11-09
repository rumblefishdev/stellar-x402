// The topic, the path to Slack, and every alarm of the groups that are on (0027 decisions 12, 26).
import * as cdk from "aws-cdk-lib";
import * as chatbot from "aws-cdk-lib/aws-chatbot";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { addAvailabilityAlarms } from "../alarms/availability.js";
import { addCostSilenceAlarms } from "../alarms/cost-silence.js";
import { addUpstreamAlarms } from "../alarms/upstream.js";
import { AlarmFactory } from "../alarms/factory.js";
import { addHostAlarms } from "../alarms/host.js";
import { addMoneyAlarms } from "../alarms/money.js";
import { addProtocolAlarms } from "../alarms/protocol.js";
import { addSettlementAlarms } from "../alarms/settlement.js";
import type { EnvironmentConfig } from "../config.js";
import { names } from "../names.js";

export interface AlarmsStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class AlarmsStack extends cdk.Stack {
  readonly alarms: AlarmFactory;

  constructor(scope: Construct, id: string, props: AlarmsStackProps) {
    super(scope, id, props);
    const { config } = props;
    const n = names(config.envName);

    // No `addToResourcePolicy` here, ever: an AWS::SNS::TopicPolicy replaces the topic's default
    // policy, which is what lets this account's alarms publish. The explorer's did, and every
    // alarm went mute twice (2026-08-18 and 2026-08-27). No KMS key either: CloudWatch would need
    // a grant on it to publish.
    const topic = new sns.Topic(this, "AlarmTopic", {
      topicName: n.alarmTopic,
      displayName: `x402 ${config.envName} alarms`,
    });

    // The workspace and channel IDs stay out of this public repo: SSM parameters set once by hand
    // (infra/README.md), resolved by CloudFormation at deploy, so synth needs no AWS access.
    new chatbot.SlackChannelConfiguration(this, "SlackChannel", {
      slackChannelConfigurationName: n.slackChannel,
      slackWorkspaceId: ssm.StringParameter.valueForStringParameter(
        this,
        config.slack.workspaceIdSsmParam,
      ),
      slackChannelId: ssm.StringParameter.valueForStringParameter(
        this,
        config.slack.channelIdSsmParam,
      ),
      notificationTopics: [topic],
      // The default, NONE, leaves the last hop unauditable: the Prices API's three test publishes
      // reached no one and no log said why (their 0112).
      loggingLevel: chatbot.LoggingLevel.ERROR,
      role: new iam.Role(this, "ChatbotRole", {
        assumedBy: new iam.ServicePrincipal("chatbot.amazonaws.com"),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchReadOnlyAccess")],
      }),
      // The default guardrail is AdministratorAccess; on a shared account the channel's own
      // ceiling says read-only too (decision 32).
      guardrailPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchReadOnlyAccess")],
    });

    this.alarms = new AlarmFactory(this, {
      envName: config.envName,
      groups: config.alarmGroups,
      action: new cloudwatchActions.SnsAction(topic),
    });
    addAvailabilityAlarms(this.alarms, config);
    addMoneyAlarms(this.alarms, config);
    addProtocolAlarms(this.alarms, config);
    addSettlementAlarms(this.alarms, config);
    addHostAlarms(this.alarms, config);
    addCostSilenceAlarms(this.alarms, config);
    addUpstreamAlarms(this.alarms);

    new cdk.CfnOutput(this, "AlarmTopicArn", { value: topic.topicArn });
  }
}
