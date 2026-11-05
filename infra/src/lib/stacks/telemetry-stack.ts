// The server's only AWS credential (ADR 0011, "Keys, secrets and access"; 0027 decisions 6, 25,
// 29-31): an IAM Roles Anywhere trust anchor on the ClickHouse project's client CA, a profile, and
// a logging role that the CloudWatch agent's certificate assumes. The role only writes: our two
// log groups and the agent's own metrics, only from the server's IP. It can't read anything,
// sign anything or reach a secret. The log groups are here too, since the role names them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rolesanywhere from "aws-cdk-lib/aws-rolesanywhere";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import { INFRA_ROOT, names } from "../names.js";

/** The only namespace the agent publishes to with `PutMetricData`: memory and disk (#113). */
export const AGENT_NAMESPACE = "x402-host";

export interface TelemetryStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

export class TelemetryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TelemetryStackProps) {
    super(scope, id, props);
    const { config } = props;
    const n = names(config.envName);

    // Both kept 30 days (decision 18), Standard class, and kept on a stack delete: their history
    // is meant to outlive the host (decisions 1, 31). Not on a failed first create's rollback, or
    // the empty groups would block the next deploy with "already exists".
    const logGroup = (cid: string, logGroupName: string) =>
      new logs.LogGroup(this, cid, {
        logGroupName,
        retention: logs.RetentionDays.ONE_MONTH,
        logGroupClass: logs.LogGroupClass.STANDARD,
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });
    const app = logGroup("AppLogGroup", n.appLogGroup);
    const metrics = logGroup("MetricsLogGroup", n.metricsLogGroup);

    // A public certificate, committed so that a change of trust root is reviewed (decision 29).
    const ca = readFileSync(join(INFRA_ROOT, config.logging.trustAnchorCertificate), "utf8");
    const anchor = new rolesanywhere.CfnTrustAnchor(this, "TrustAnchor", {
      name: n.trustAnchor,
      enabled: true,
      source: { sourceType: "CERTIFICATE_BUNDLE", sourceData: { x509CertificateData: ca } },
    });

    // The CA signs other projects' certificates too (the explorer's, the Prices API's), and every
    // one of them can reach this anchor. So the trust policy takes only our CN and only our
    // anchor (decision 25).
    const trust = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("rolesanywhere.amazonaws.com")],
          actions: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
          conditions: {
            StringEquals: { "aws:PrincipalTag/x509Subject/CN": config.logging.certificateCn },
            ArnEquals: { "aws:SourceArn": anchor.attrTrustAnchorArn },
          },
        }),
      ],
    });

    // The IP is on every allowed action: a session used anywhere but the server gets nothing.
    // Kept out of the repo as the explorer keeps its box's (decision 29), resolved at deploy.
    const serverIp = ssm.StringParameter.valueForStringParameter(
      this,
      config.logging.serverIpSsmParam,
    );
    const fromServer = { IpAddress: { "aws:SourceIp": cdk.Fn.join("", [serverIp, "/32"]) } };
    const permissions = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "WriteOurLogGroups",
          // No CreateLogGroup or PutRetentionPolicy: the groups and their retention are this
          // stack's, so the agent's config can't change them (decision 30).
          actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
          resources: [app.logGroupArn, metrics.logGroupArn],
          conditions: fromServer,
        }),
        new iam.PolicyStatement({
          sid: "PutAgentMetrics",
          // PutMetricData has no resource-level scoping, so it is `*` with the namespace as a
          // condition (the Prices API's eventbridge-stack.ts). EMF lines need no PutMetricData.
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: {
            ...fromServer,
            StringEquals: { "cloudwatch:namespace": AGENT_NAMESPACE },
          },
        }),
      ],
    });

    const sessionSeconds = config.logging.sessionHours * 3600;
    const role = new iam.CfnRole(this, "LoggingRole", {
      roleName: n.loggingRole,
      description: `The CloudWatch agent on the x402 server, through IAM Roles Anywhere: writes our log groups and ${AGENT_NAMESPACE} metrics, from the server's IP only (task 0027).`,
      assumeRolePolicyDocument: trust,
      maxSessionDuration: sessionSeconds,
      policies: [{ policyName: "write-logs-and-host-metrics", policyDocument: permissions }],
    });

    const profile = new rolesanywhere.CfnProfile(this, "Profile", {
      name: n.rolesAnywhereProfile,
      enabled: true,
      roleArns: [role.attrArn],
      // The sessions #113's `aws_signing_helper update` asks for; the role allows as long.
      durationSeconds: sessionSeconds,
    });

    // What the helper on the server is started with. Plain outputs, no exports (decision 27).
    new cdk.CfnOutput(this, "TrustAnchorArn", { value: anchor.attrTrustAnchorArn });
    new cdk.CfnOutput(this, "ProfileArn", { value: profile.attrProfileArn });
    new cdk.CfnOutput(this, "RoleArn", { value: role.attrArn });
  }
}
