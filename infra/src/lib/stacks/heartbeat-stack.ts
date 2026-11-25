// The monitoring VM's heartbeat and its AWS identity (ADR 0011, "Heartbeat" and "The VM's AWS
// identity"; lore 0139). Alertmanager's always-firing Watchdog reaches this stack's topic every
// minute; an alarm on the topic's published messages fires when that stops: Prometheus,
// Alertmanager or the VM gone quiet, or the VM's credential broken. The VM's role may only publish
// to that topic and the alarm topic (the failed-notification route), from the VM's IP only.
// The alarm topic reaches Slack through Amazon Q, which drops any message not in its custom-
// notification envelope (`version`, `source: "custom"`, `content`; the Prices API's
// `alarm_digest.rs`), so Alertmanager's SNS receiver for it must send that envelope.
// Its own stack, apart from Alarms and Telemetry, as every stack here (0027 decision 27).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rolesanywhere from "aws-cdk-lib/aws-rolesanywhere";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import { INFRA_ROOT, names } from "../names.js";

/**
 * Watchdog publishes every minute; two silent 5-minute periods fire. CloudWatch waits for late
 * data before it treats a period as missing, so it fired about 20 minutes in (drill, 2026-11-24).
 */
export const HEARTBEAT_PERIOD_MINUTES = 5;
export const HEARTBEAT_PERIODS = 2;

export interface HeartbeatStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class HeartbeatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HeartbeatStackProps) {
    super(scope, id, props);
    const { config } = props;
    const n = names(config.envName);

    // The default policy only, as the alarm topic's (alarms-stack.ts): a topic policy replaces it.
    const topic = new sns.Topic(this, "HeartbeatTopic", {
      topicName: n.heartbeatTopic,
      displayName: `x402 ${config.envName} monitoring heartbeat`,
    });
    // By name, not by reference: stacks never pass resources to each other (decision 27).
    const alarmTopicArn = cdk.Stack.of(this).formatArn({
      service: "sns",
      resource: n.alarmTopic,
      arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
    });

    if (config.alarmGroups.heartbeat) {
      const alarm = new cloudwatch.Alarm(this, "HeartbeatAlarm", {
        alarmName: n.heartbeatAlarm,
        alarmDescription:
          "Alertmanager's Watchdog stopped reaching the heartbeat topic: Prometheus, Alertmanager or the monitoring VM is down, or the VM's AWS credential is broken, so the Prometheus rules page no one. " +
          "Next: did the Watchdog reach SNS (the topic's NumberOfMessagesPublished), then ssh monitoring and the Watchdog alert in Alertmanager. " +
          "No data: breaching, since silence is what this alarm is for. " +
          "Runbook: docs/monitoring.md, monitoring-heartbeat.",
        metric: topic.metricNumberOfMessagesPublished({
          period: cdk.Duration.minutes(HEARTBEAT_PERIOD_MINUTES),
          statistic: cloudwatch.Stats.SUM,
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: HEARTBEAT_PERIODS,
        datapointsToAlarm: HEARTBEAT_PERIODS,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      const action = new cloudwatchActions.SnsAction(
        sns.Topic.fromTopicArn(this, "AlarmTopic", alarmTopicArn),
      );
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }

    // Its own anchor on the same CA as the server's (telemetry-stack.ts), so this stack stands
    // alone; the trust policy takes only the VM's CN and only this anchor.
    const ca = readFileSync(join(INFRA_ROOT, config.logging.trustAnchorCertificate), "utf8");
    const anchor = new rolesanywhere.CfnTrustAnchor(this, "TrustAnchor", {
      name: n.monitoringVm,
      enabled: true,
      source: { sourceType: "CERTIFICATE_BUNDLE", sourceData: { x509CertificateData: ca } },
    });
    const trust = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("rolesanywhere.amazonaws.com")],
          actions: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
          conditions: {
            StringEquals: { "aws:PrincipalTag/x509Subject/CN": config.monitoringVm.certificateCn },
            ArnEquals: { "aws:SourceArn": anchor.attrTrustAnchorArn },
          },
        }),
      ],
    });

    const vmIp = ssm.StringParameter.valueForStringParameter(this, config.monitoringVm.ipSsmParam);
    const permissions = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "PublishHeartbeatAndAlarms",
          actions: ["sns:Publish"],
          resources: [topic.topicArn, alarmTopicArn],
          conditions: { IpAddress: { "aws:SourceIp": cdk.Fn.join("", [vmIp, "/32"]) } },
        }),
      ],
    });

    const sessionSeconds = config.logging.sessionHours * 3600;
    const role = new iam.CfnRole(this, "MonitoringVmRole", {
      roleName: n.monitoringVm,
      description: `Alertmanager on the monitoring VM, through IAM Roles Anywhere: publishes to the heartbeat and alarm topics, from the VM's IP only (task 0139).`,
      assumeRolePolicyDocument: trust,
      maxSessionDuration: sessionSeconds,
      policies: [{ policyName: "publish-heartbeat-and-alarms", policyDocument: permissions }],
    });
    const profile = new rolesanywhere.CfnProfile(this, "Profile", {
      name: n.monitoringVm,
      enabled: true,
      roleArns: [role.attrArn],
      durationSeconds: sessionSeconds,
    });

    // What the VM's signing helper and Alertmanager's SNS receiver are set up with.
    new cdk.CfnOutput(this, "HeartbeatTopicArn", { value: topic.topicArn });
    new cdk.CfnOutput(this, "TrustAnchorArn", { value: anchor.attrTrustAnchorArn });
    new cdk.CfnOutput(this, "ProfileArn", { value: profile.attrProfileArn });
    new cdk.CfnOutput(this, "RoleArn", { value: role.attrArn });
  }
}
