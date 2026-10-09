# ADR 0011: Host the facilitator on ECS Fargate in the company AWS account

- Status: accepted
- Date: 2026-10-09

## Context

`apps/facilitator` is the only deployable service (AD-1): one Node 22 process per network that
holds the channel pool, `/verify`, `/settle`, `/supported` and `/discovery/resources`. The Tranche 1
gate needs it at a public HTTPS testnet URL (AD-15, ADR 0009); mainnet follows in a later tranche
with a 99% uptime target.

The host must:

- **keep the process running.** The pool does background work between requests, so no
  scale-to-zero and no idle CPU throttling;
- **stop the old process before the new one starts.** One process owns a channel set through a
  store lease, so deploys can't overlap (AD-17);
- **give at least 90–120 s after SIGTERM.** The process drains in-flight submissions, and with the
  pool's defaults (`timeoutSeconds` 60 + `confirmGraceSeconds` 30) one can take ~90 s;
- **keep the facilitator key in a secret store,** never in the image or the logs (AD-12);
- **offer a durable store** for whatever task 0013 picks, likely managed Postgres.

Rumble Fish's default cloud is AWS. The facilitator goes into the company account that already
runs sorobanscan and the Stellar Prices API. The `rumblefish.dev` zone is on Route 53, and the
Prices API runs in Frankfurt. The full requirements and the
research are in task 0014's notes.

## Decision

### Platform and service

- **ECS on Fargate** in the AWS account shared with sorobanscan and the Prices API, region
  eu-central-1 unless the account says otherwise.
- **Testnet and mainnet are separate stacks** in that account, kept apart by IAM. Each has its own
  task roles and its own secret path; on mainnet, the KMS key policy lets only the mainnet task
  role sign.
- **One ECS service per network,** `desiredCount` 1, Linux ARM64. Testnet starts at 0.25 vCPU and
  0.5 GB; resizing is a task definition change.
- **Stop-before-start deploys:** `minimumHealthyPercent` 0 and `maximumPercent` 100, so ECS stops
  the old task before it starts the new one. The deployment circuit breaker rolls back a failed
  deploy.
- **`stopTimeout` 120 s,** Fargate's maximum. The shutdown drain (AD-17, task 0025) must finish
  inside it.
- **Liveness is `GET /health`.** It answers 200 while the HTTP server is up and checks nothing
  else: not the lease, the RPC or the store. A dependency outage then doesn't make ECS restart the
  task in a loop. The ALB target group and the ECS deployment use it.

### Container, image and deploys

- **`apps/facilitator/Dockerfile`**, multi-stage:
  - the build stage installs with pnpm, builds the workspace and runs `pnpm deploy --prod` for the
    facilitator;
  - the runtime stage is `node:22-slim`, runs as `node`, with `CMD ["node", "dist/server.js"]`.
    Node is PID 1 and handles SIGTERM itself (`src/server.ts`); no npm or pnpm wrapper sits in
    between.
- **Images go to ECR,** tagged with the git SHA, immutable tags.
- **GitHub Actions deploys.** They build natively on the `ubuntu-24.04-arm` runner (free for
  public repositories).
  - Testnet deploys on a push to `develop`, or by hand.
  - Mainnet deploys by hand from a tag, through a GitHub environment with required reviewers.
- **No AWS keys in GitHub.** The workflow assumes an IAM role through OIDC. The role's trust
  policy is pinned to this repository and to the branch or environment that may deploy.
  `amazon-ecs-deploy-task-definition` runs with `wait-for-service-stability: true`.
- **Rollback** redeploys the previous SHA.
- **Infrastructure as code: AWS CDK in TypeScript** under `deploy/infra/`, one stack per network
  with its own config. It uses the repo's language and package manager, and the ECS patterns
  construct covers the ALB, service, certificate and DNS record. Nothing else here depends on the
  tool; if the company standardizes on Terraform, use that.

### Network and URL

- **Internet-facing ALB** with an ACM certificate on a `rumblefish.dev` subdomain. The proposal is
  `testnet.x402.rumblefish.dev`, settled with the zone's owner in 0026. HTTP redirects to HTTPS.
- **ALB idle timeout 120 s,** so the ALB never cuts a slow `/settle`. Target deregistration delay
  10 s.
- **`TRUSTED_PROXY_HOPS=1`** (AD-11): the ALB is the one proxy that appends `X-Forwarded-For`.
- **The task sits in a public subnet with a public IP,** so it reaches Stellar RPC without a NAT
  gateway. Its security group admits only the ALB.
- **Fallback without DNS access:** CloudFront's default domain in front of the ALB, with the
  origin timeout raised to cover `/settle` and `TRUSTED_PROXY_HOPS=2`.

### Secrets and keys

- **`FACILITATOR_SECRET` is an SSM Parameter Store SecureString** under `/x402/<network>/`. The
  task definition's `secrets` field injects it, and only the task execution role can read that
  path. The value is read once at start, so rotating the key means updating the parameter and
  redeploying.
- **Mainnet moves the key into AWS KMS,** behind the pool's `TransactionSigner`:
  - key spec `ECC_NIST_EDWARDS25519`, algorithm `ED25519_SHA_512` with `MessageType: RAW`, over
    the 32-byte transaction hash (pure Ed25519, as Stellar signs);
  - `ED25519_PH_SHA_512` is HashEdDSA and gives signatures Stellar rejects;
  - a spike first proves that a KMS signature verifies with `stellar-base`.

### Store

- **Whatever 0013 chooses must run here.** RDS PostgreSQL in the same VPC fits: db.t4g.micro
  single-AZ on testnet, Multi-AZ on mainnet.
- **SQLite would need EC2 with EBS.** Fargate's only persistent volume is EFS, an NFS mount, and
  SQLite advises against network filesystems.

### Logs, metrics and alerts

- **Logs:** the 0017 `jsonLogger` stays. Its JSON lines go from stdout through the `awslogs`
  driver into CloudWatch Logs, Standard class (Infrequent Access drops metric extraction), with
  30-day retention on testnet. No pino: stdout is the only transport, and the logger already
  writes identifiers only.
- **RPC URLs are logged by host only.** An RPC URL can carry an API key, so the app never logs the
  full URL.
- **Metrics:** a metrics adapter (0027) writes CloudWatch Embedded Metric Format lines to stdout,
  and `awslogs` turns them into metrics. No SDK and no agent.
  - Namespace `x402-facilitator`.
  - Dimensions stay low-cardinality: `network`, route, outcome, event name.
  - Never payer or `payTo`: each dimension combination is a billed custom metric.
- **Alerts:** CloudWatch alarms go to an SNS topic, and Amazon Q Developer in chat applications
  (formerly AWS Chatbot) posts them to the team's Slack channel. 0027 defines the conditions.
- **Uptime:** a Route 53 HTTPS health check on the public `/supported` measures availability
  against the 99% target, with an alarm.

## Rationale

- **It meets both hard rules.** Fargate stops the old task first when `maximumPercent` is 100,
  and it allows 120 s after SIGTERM.
- **It's the company default,** and AWS already holds the account, the DNS zone, managed Postgres
  and, for mainnet, an Ed25519 KMS. No new vendor.
- **Fargate patches and replaces the host.** On EC2 that would be our job.
- **Observability adds nothing to run.** The existing stdout logger feeds logs and metrics, and
  alarms reach Slack through managed services.
- **Testnet to mainnet is config,** not a re-platform: the same account, stack, image and
  workflow.

## Alternatives considered

- **Fly.io Machines.** Stop-first with one Machine, up to 300 s after SIGTERM, `*.fly.dev` HTTPS,
  about $8/mo plus $38/mo for managed Postgres.
  - It is the closest alternative.
  - Rejected: a new vendor with no KMS for mainnet custody and an SLA only on Enterprise, when the
    company default already fits.
- **EC2 with Docker.** About $30/mo cheaper and allows any grace period and SQLite on EBS. But we
  would own OS patching, the deploy and failure recovery. Rejected; it's the fallback if 0013
  needs a local disk.
- **Render.** Deploys overlap unless a disk is attached; with a disk, the shutdown delay
  reportedly can't be raised past 30 s. Rejected.
- **Railway.** Deploys overlap even with zero overlap set; a volume forces stop-first, but the
  drain time in that mode is undocumented. Rejected.
- **Google Cloud Run.** SIGTERM gives a fixed 10 s, and new revisions start before old ones stop.
  Rejected.
- **AWS App Runner, ECS Express Mode, Lightsail containers.**
  - App Runner has been closed to new customers since 2026-04-30 and throttles idle CPU.
  - Express Mode and Lightsail overlap deploys.
  - Rejected.
- **EKS.** $73/mo for the control plane alone, for one container. Rejected.
- **Lambda behind API Gateway** (the Prices API's stack). No long-lived process. Rejected.
- **Grafana Cloud Free for metrics, alerts and uptime.** `prom-client` serves `/metrics` for a
  hosted scrape, plus Synthetic Monitoring; $0 and portable across hosts. Rejected:
  - it is a second vendor with its own accounts;
  - its alert rules sit outside our infrastructure code;
  - a token-protected `/metrics` would sit on the public URL.

  CloudWatch is already in the account, for about $10–25/mo.

## Consequences

- **The drain has a hard 120 s ceiling.** 0025's shutdown must finish within about 110 s. The
  pool's timeouts can't grow past it without lowering `confirmGraceSeconds`.
- **Every deploy is 1–3 min of downtime.** That covers deregistration, the drain and the new task's
  start, and is inherent to stop-first. Fargate task retirement causes the same blip, with 7 days'
  notice. It fits the 99% budget (about 7 h a month), but testnet deploys should avoid gate runs.
- **0026 needs a `rumblefish.dev` subdomain** and access to its Route 53 zone, or uses the
  CloudFront fallback.
- **0026 builds:** the Dockerfile, the CDK stack, `GET /health`, the deploy workflow and the SSM
  parameter, plus the deploy and rollback steps in `docs/runbook.md`.
- **0027 builds:** the EMF metrics adapter, the alarms and the Slack integration, and the uptime
  check. It confirms once that `awslogs` extracts EMF in our setup.
- **0013 is constrained:** managed Postgres on RDS fits this host; SQLite would mean EC2.
- **Cost:**
  - Testnet is about $60–70/mo: Fargate $8–17, ALB $20–25, public IPv4 $11, RDS $17, CloudWatch
    and the health check a few dollars.
  - Mainnet is about $190–250/mo, sized at two 1 vCPU / 2 GB tasks, Multi-AZ db.t4g.small and KMS.
    A NAT gateway would add $38–76.
- **Slack is not a pager.** On mainnet, the alerts that cost money (breaker open, low balance,
  pending settlements) also need a phone or SMS route.
- **The key's isolation rests on IAM.** In an account shared with other services, an account
  administrator can still read an SSM secret. That is acceptable for the testnet key; on mainnet
  KMS removes the raw key altogether.
- **Mainnet custody needs a KMS signer spike** before mainnet (task 0036).

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-1, AD-11, AD-12, AD-15, AD-17, AD-18
- [ADR 0009](0009-conformance-gate-harness.md): the gate needs the public URL
- Task 0014 notes (`0014_RESEARCH_facilitator-hosting/notes/`):
  - `G-hosting-requirements`;
  - `R-cloud-container-options`: AWS in depth with Frankfurt prices, Cloud Run, Azure,
    Kubernetes, KMS;
  - `R-paas-and-vm-options`: Fly.io, Railway, Render, a single VM;
  - `R-observability-backends`;
  - `S-hosting-decision`: the comparison table.
- [ECS task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
  (`stopTimeout`),
  [ECS service parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)
  (deployment percentages),
  [AWS KMS Ed25519](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html),
  [EMF on ECS](https://docs.aws.amazon.com/prescriptive-guidance/latest/implementing-logging-monitoring-cloudwatch/metrics-for-amazon-ecs.html)
  (checked 2026-10-09)
