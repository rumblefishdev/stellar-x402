# ADR 0011: Host the facilitator on ECS Fargate in the company AWS account

- Status: accepted
- Date: 2026-10-09
- Amended: 2026-10-15 (task 0009, PR #41 review): the `/settle` budget is 30 s, below the
  seller's own 90 s timeout

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
  pool's defaults (`timeoutSeconds` 60 + `confirmGraceSeconds` 30) a sent one can take ~90 s;
- **keep the facilitator key in a secret store,** never in the image or the logs (AD-12);
- **offer a durable store** for whatever task 0013 picks, likely managed Postgres.

Rumble Fish's default cloud is AWS. The facilitator goes into the company account that already
runs sorobanscan and the Stellar Prices API. The `rumblefish.dev` zone is on Route 53, and the
Prices API runs in Frankfurt. The full requirements and the research are in task 0014's notes.

## Decision

### Platform and service

- **ECS on Fargate** in the AWS account shared with sorobanscan and the Prices API, region
  eu-central-1 unless the account says otherwise.
- **One ECS service per network,** `desiredCount` 1, Linux ARM64. Testnet starts at 0.25 vCPU and
  0.5 GB; resizing is a task definition change. Testnet and mainnet are separate stacks, kept
  apart by IAM (see Keys, secrets and access).
- **Stop-before-start deploys:** `minimumHealthyPercent` 0 and `maximumPercent` 100, so ECS stops
  the old task before it starts the new one.
  - **The lease guarantees one owner, not this ordering** (AD-17). If a new task starts while the
    old one is still deregistering, it waits for the lease and never exits for lack of it.
- **The deployment circuit breaker rolls back** a deploy whose task doesn't start or fails its
  health check, with its threshold set to one failed task. The default for one task is three, and
  with stop-first each failed attempt is a full outage.
- **`stopTimeout` 120 s,** Fargate's maximum. The shutdown drain (AD-17, task 0025) must finish
  inside it.

### Liveness and readiness

- **`GET /health` is liveness only.** It answers 200 while the HTTP server is up and checks nothing
  else: not the lease, the RPC or the store, so a dependency outage doesn't make ECS restart the
  task in a loop. The ALB target group and the ECS deployment use it. Its body reports `ready`.
- **Ready to settle** means the process holds the lease and has finished the AD-16 startup
  reconciliation, which runs after the lease is taken.
  - Until then, `/settle` answers 503 at once instead of hanging.
  - A process without the lease keeps trying to take it.
  - A process whose lease renewal fails stops new submissions until it holds the lease again.
- **ECS can't see readiness,** so a deploy that never becomes ready passes the circuit breaker.
  Two things catch it:
  - the deploy workflow's last step waits for `ready: true` and fails the run otherwise;
  - a "ready to settle" metric has an alarm (0027).

### Timing

One request or one stop must never outlast the layer in front of it:

| Setting                           | Value               | Why                                                                |
| --------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Seller's facilitator client       | 90 s                | `@x402/core`'s `HTTPFacilitatorClient`; started before the request |
| `/settle` response budget         | 30 s, at most 80 s  | well below the seller's 90 s, so our answer reaches it             |
| Repeat wait (`SETTLE_TIMEOUT_MS`) | 20 s, ≤ the budget  | a repeat waits at most what the call could take                    |
| ALB target deregistration delay   | 100 s               | in-flight `/settle` finishes before SIGTERM                        |
| ALB idle timeout                  | 120 s               | above the response budget                                          |
| Node `keepAliveTimeout`           | 125 s               | above the ALB idle timeout, or the ALB sees 502s                   |
| `stopTimeout`                     | 120 s               | background drain after SIGTERM                                     |
| Target health check               | 10 s × 2, 3 to fail | a new target gets traffic within ~20 s                             |
| `LEASE_TTL_MS`                    | 30 s                | after a crash, a new process waits at most this long               |

- **Past the budget,** `/settle` answers `settlement_pending` with the hash if one was signed,
  and nothing new is signed after it. If nothing was signed, the record ends and the answer is
  `settle_exact_stellar_timeout`: the client signs a new payment. 30 s fits 97 % of the
  settlements measured in task 0043. Every store and hook call is bounded by what is left of it,
  plus 1 s for the last store write.
- **The budget covers the wait for a channel.** The pool's own bounds (60 s + 30 s) start only
  once a channel is acquired, so the `/settle` handler passes the pool a deadline (0009).
- **ECS waits out the whole deregistration delay on every stop,** even with nothing in flight: the
  ALB reports the target as draining until the delay ends.

### Container, image and deploys

- **`apps/facilitator/Dockerfile`**, multi-stage:
  - the build stage installs with pnpm, builds the workspace and runs `pnpm deploy --prod`. That
    needs `injectWorkspacePackages: true` in `pnpm-workspace.yaml` (pnpm 10 and later; checked
    with 11.5.2: workspace packages stay symlinked in dev, and the deploy output gets its own
    lockfile);
  - `pnpm deploy` copies the whole package directory, so `apps/facilitator/package.json` gets
    `"files": ["dist"]` and the repo a `.dockerignore` that excludes `.env*`;
  - the runtime stage is `node:22-slim` pinned by digest, runs as `node`, with a read-only root
    filesystem and `CMD ["node", "dist/server.js"]`. Node is PID 1 and handles SIGTERM itself
    (`src/server.ts`); no npm or pnpm wrapper sits in between.
- **ECS Exec stays off:** the key is in the process environment.
- **One ECR repository for both networks.**
  - Tags are git SHAs and immutable; images are scanned on push.
  - A lifecycle rule keeps the recent images that rollbacks need.
  - The workflow skips the build when the SHA is already there.
  - Mainnet deploys the digest that ran on testnet instead of rebuilding it.
- **Infrastructure as code: AWS CDK in TypeScript** under `deploy/infra/`, with its own bootstrap
  qualifier so it doesn't share or widen any existing CDK bootstrap in the account. Per network:
  - an **infra stack** for the VPC, ALB, certificate, DNS record, KMS keys, IAM roles and alarms,
    applied by a person when infrastructure changes;
  - a **service stack** for the task definition and the ECS service, with the image digest as a
    parameter, applied by the deploy workflow. Its CloudFormation execution policy covers only
    ECS, its log group and passing the two roles the infra stack made.
- **The service stack is the only owner of the task definition.** No separate
  `amazon-ecs-deploy-task-definition` step: CloudFormation waits for the service to stabilize,
  and fails with the circuit breaker.
- **GitHub Actions deploys**, building natively on the `ubuntu-24.04-arm` runner (free for public
  repositories).
  - Testnet deploys on a push to `develop` unless only `lore/**`, `docs/**` or Markdown files
    changed, or by hand.
  - Mainnet deploys by hand from a tag, through the `mainnet` environment with required
    reviewers.
  - One deploy runs at a time per network (a `concurrency` group).
  - Every action is pinned to a commit SHA. The workflow sets `permissions: {}` and gives the
    deploy job only `id-token: write` and `contents: read`.
- **Rollback** redeploys an earlier SHA's image through the same workflow.

### Network and URL

- **A `rumblefish.dev` subdomain is a prerequisite.** The proposal is
  `testnet.x402.rumblefish.dev`, settled with the zone's owner in 0026.
  - It can be a record in the company zone or a subzone delegated to the infra stack.
  - There is no CloudFront fallback.
- **Internet-facing ALB, HTTPS only,** with an ACM certificate and an explicit TLS policy
  (`SslPolicy.RECOMMENDED_TLS` or newer). There is no plain-HTTP listener.
- **`TRUSTED_PROXY_HOPS=1`** (AD-11): the ALB is the one proxy that appends `X-Forwarded-For`.
  It is Express's numeric `trust proxy`, so the client IP is the rightmost entry (0023).
- **The task sits in a public subnet with a public IP,** so it reaches Stellar RPC without a NAT
  gateway. Its security group admits only the ALB.
- **No edge rate limiting on testnet;** the in-app limits (AD-11, AD-18) apply. Mainnet decides
  on a WAF rate-based rule.

### Keys, secrets and access

- **`FACILITATOR_SECRET` is an SSM Parameter Store SecureString** under `/x402/<network>/`.
  - It is encrypted with that network's own KMS key, not the default `aws/ssm` key: anyone in
    the account allowed `ssm:GetParameter` could decrypt with `aws/ssm`.
  - The key policy gives `kms:Decrypt` only to the network's task execution role, through SSM.
    Administrators can manage the key but not decrypt with it.
- **A person creates the parameter** with `aws ssm put-parameter --type SecureString`.
  CloudFormation can't create SecureStrings; the stack only references the parameter. The task
  definition's `secrets` field injects it at start.
- **Every other credential goes the same way:** an RPC URL that carries an API key, and the
  database credentials. Never plain `environment`, which is visible in the task definition.
- **Rotating the key is an on-chain change.** AD-12 makes the facilitator key the only signer of
  every channel, so the service won't start with a new key. Rotation means:
  1. stop the service;
  2. with the old key, make the new key the signer of every channel and the fee account;
  3. update the parameter;
  4. start the service.

  The runbook (0026) also covers the compromised-key case.

- **Two deploy roles, assumed through OIDC,** with no AWS keys in GitHub:
  - **testnet:** trusts only `repo:rumblefishdev/stellar-x402:ref:refs/heads/develop`. It may
    push to ECR, run the testnet migration task, deploy the testnet service stack, and pass only
    the testnet task and execution roles;
  - **mainnet:** trusts only `repo:rumblefishdev/stellar-x402:environment:mainnet`. That
    environment allows `v*` tags only and needs a reviewer other than the person deploying. The
    role may pull from ECR, not push.
- **Mainnet moves the key into AWS KMS,** behind the pool's `TransactionSigner`:
  - key spec `ECC_NIST_EDWARDS25519`, algorithm `ED25519_SHA_512` with `MessageType: RAW`, over
    the 32-byte transaction hash (pure Ed25519, as Stellar signs); `ED25519_PH_SHA_512` is
    HashEdDSA and gives signatures Stellar rejects;
  - the key policy denies `kms:Sign` to everyone but the mainnet task role. Key administrators
    can't sign, and only a break-glass role may disable the key or schedule its deletion;
  - a spike proves the signature first (0036).
- **CloudTrail alarms on the keys:** use of either key by another principal, a key-policy change,
  or a scheduled deletion (0027 for testnet, 0036 for mainnet).

### Store

- **Whatever 0013 chooses must run here.** RDS PostgreSQL in the same VPC fits: db.t4g.micro
  single-AZ on testnet, db.t4g.small Multi-AZ on mainnet.
- **Task 0013 proposes one RDS PostgreSQL instance per network** (ADR 0012, in review). It adds
  to this ADR:
  - isolated private subnets for the database;
  - a one-off migration task. The deploy workflow runs it from the new image before each service
    update. The old task keeps serving while it runs, so every migration is expand/contract.
- **SQLite would need EC2 with EBS.** Fargate's only persistent volume is EFS, an NFS mount, and
  SQLite advises against network filesystems.

### Logs, metrics and alerts

- **Logs:** the 0017 `jsonLogger` stays.
  - Its JSON lines go from stdout through the `awslogs` driver into CloudWatch Logs, Standard
    class (Infrequent Access drops metric extraction), with 30-day retention on testnet.
  - No pino: stdout is the only transport, and the logger already writes identifiers only.
- **RPC URLs are logged by host only.** An RPC URL can carry an API key, and signer-pool's
  `FallbackRpc.fromUrls` names endpoints by the full URL today (0027).
- **Metrics:** a metrics adapter (0027) writes CloudWatch Embedded Metric Format lines to stdout,
  and `awslogs` turns them into metrics. No SDK and no agent.
  - Namespace `x402-facilitator`.
  - Dimensions stay low-cardinality: `network`, route, outcome, event name.
  - Never payer or `payTo`: each dimension combination is a billed custom metric.
- **Alerts:** CloudWatch alarms go to an SNS topic, and Amazon Q Developer in chat applications
  (formerly AWS Chatbot) posts them to the team's Slack channel. 0027 defines them:
  - the five AD-18 conditions;
  - not ready to settle (the counterpart of the lease-blind `/health`);
  - the key events above;
  - AWS Health task-retirement notices.
- **Uptime:** a Route 53 HTTPS health check on the public URL.
  - Route 53 publishes its metrics only in us-east-1, so the alarm and its SNS topic live in a
    small us-east-1 stack, subscribed to the same Slack channel.
  - The alarm fires only after more failing minutes than a deploy's downtime.
  - It checks `/supported` once 0020 makes it real. Until then it checks `/health`, which is
    equivalent, because `/supported` is static.
  - The 99% figure counts a minute as up only when the check passes and the facilitator is ready
    to settle.

## Rationale

- **It meets both hard rules.** Fargate stops the old task first when `maximumPercent` is 100,
  and it allows 120 s after SIGTERM.
- **It's the company default,** and AWS already holds the account, the DNS zone, managed Postgres
  and, for mainnet, an Ed25519 KMS. No new vendor.
- **Fargate patches and replaces the host.** On EC2 that would be our job.
- **Observability adds nothing to run.** The existing stdout logger feeds logs and metrics, and
  alarms reach Slack through managed services.
- **Testnet to mainnet is config,** not a re-platform: the same account, stacks, image and
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
- **Step Functions with Lambda:** a workflow per payment, with channel state in the database.
  - What it would bring: deploys without downtime, and payments in flight survive restarts
    without our own code.
  - **It means rewriting the settlement engine.** `signer-pool` keeps each channel's sequence
    number, the queue of payments and the next prepared transaction in one process's memory.
    Lambdas share no memory, so all of that moves into the database with a lock per payment.
    - AD-2, AD-16, AD-17 and AD-22 change with it.
    - Pipelining is lost: at 90 channels it raised the mean from 50 to 64 per ledger (ADR 0003).
  - **It fights the store design.** Lambdas need RDS Proxy in front of PostgreSQL, against a
    small fixed pool per task, and the in-process rate-limit counters (0023) go away.
  - **Every step is billed:** $0.025 per 1,000 transitions on Standard workflows, a visible share
    of a sub-cent payment. Express workflows are cheaper but run a step at least once, which
    risks a second send.
  - **Timeouts are not the blocker.** An HTTP API stops at 30 s, but a REST API with a raised
    limit or an ALB in front of the Lambdas can wait for `/settle`.
  - Rejected for the facilitator.
  - It still fits side jobs, such as topping up the fee balance and rebuilding channels after a
    testnet reset.
- **CloudFront's default domain in front of the ALB,** for HTTPS without our own subdomain.
  Rejected:
  - the CloudFront-to-ALB hop would be plain HTTP;
  - any CloudFront distribution, not only ours, could reach the ALB, so `X-Forwarded-For` could
    be forged;
  - a `/settle` of up to 80 s needs a raised origin-timeout quota;
  - the default cache and method settings break a JSON API.

  A subdomain avoids all of it.

- **Image deploys with `amazon-ecs-deploy-task-definition` next to CDK.** Two owners of the task
  definition: the next `cdk deploy` would put CloudFormation's image back. Rejected.
- **Grafana Cloud Free for metrics, alerts and uptime.** `prom-client` serves `/metrics` for a
  hosted scrape, plus Synthetic Monitoring; $0 and portable across hosts. Rejected:
  - it is a second vendor with its own accounts;
  - its alert rules sit outside our infrastructure code;
  - a token-protected `/metrics` would sit on the public URL.

  CloudWatch is already in the account, for about $10–25/mo on mainnet.

## Consequences

- **The drain has a hard 120 s ceiling.** 0025's shutdown must refuse every call not yet sent (a
  signer-pool `close()`), finish within about 110 s, and record the rest as pending.
- **After a crash or a SIGKILL,** the lease expires in 30 s, but the dead process's transactions
  stay valid for up to 60 s. Records keep each transaction's time bound, and reconciliation treats
  a hash it can't find as non-final until that bound passes (0019).
- **Every deploy is about 3 min of downtime,** up to about 5–6 min when a request and a submission
  are in flight.
  - That covers the full deregistration delay, the drain, the new task's start and two health
    checks.
  - Fargate task retirement, sometimes without notice, and host failures cause the same.
  - It fits the 99% budget (about 7 h a month). Testnet deploys skip doc-only pushes and avoid
    gate runs.
- **0026 needs the subdomain and Route 53 access** before it can deploy.
- **0026 builds:**
  - the Dockerfile, `.dockerignore` and the pnpm setting;
  - the CDK stacks;
  - both deploy roles and the SSM parameter;
  - `GET /health` with `ready`, and the Node keep-alive settings;
  - the deploy workflow with its readiness check;
  - the runbook's deploy, rollback and key-rotation steps.
- **0027 builds:** the EMF adapter, the alarms above, the us-east-1 uptime stack and the Slack
  integration. It confirms once that `awslogs` extracts EMF in our setup.
- **0009 gives `/settle` its response budget;** 0023 implements `TRUSTED_PROXY_HOPS` as above.
- **0013 is constrained:** managed Postgres on RDS fits this host; SQLite would mean EC2.
- **Cost:**
  - Testnet is about $60–70/mo: Fargate $8, ALB $20–25, public IPv4 $11, RDS $17, the KMS key $1,
    CloudWatch and the health check a few dollars.
  - Mainnet is about $150/mo: one 1 vCPU / 2 GB task, Multi-AZ db.t4g.small, KMS and CloudWatch.
    A NAT gateway would add $38–76, and a WAF a few dollars plus per-request fees.
- **Option for mainnet, not a requirement: two tasks with separate channel sets in two
  Availability Zones.**
  - It follows the model in `R-cloud-container-options` §A2: one service with `desiredCount` 2
    and `minimumHealthyPercent` 50, where each task takes a free channel set's lease.
  - A deploy then replaces the tasks one at a time: no downtime, only half the channels for a
    few minutes.
  - It also rides out task retirement, a host or zone failure, a crash, an out-of-memory kill or
    a flood that starves one task. With one task, each of these means a few minutes of downtime.
  - It costs a second task and a second channel set, and changes AD-17's one channel set per
    network.
  - The mainnet launch decides on it, together with the WAF rule.
- **Slack is not a pager.** On mainnet, the alerts that cost money (breaker open, low balance,
  pending settlements) also need a phone or SMS route.
- **The key's isolation rests on IAM and the key policies.** An account administrator can still
  change a policy. The CloudTrail alarms make that visible; on mainnet KMS keeps the raw key out of
  reach altogether.
- **Mainnet custody needs a KMS signer spike** before mainnet (0036), including what happens if the
  key is lost.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-1, AD-6, AD-11, AD-12, AD-15, AD-16,
  AD-17, AD-18
- [ADR 0009](0009-conformance-gate-harness.md): the gate needs the public URL
- Task 0014 notes (`0014_RESEARCH_facilitator-hosting/notes/`):
  - `G-hosting-requirements`;
  - `R-cloud-container-options`: AWS in depth with Frankfurt prices, Cloud Run, Azure,
    Kubernetes, KMS;
  - `R-paas-and-vm-options`: Fly.io, Railway, Render, a single VM;
  - `R-observability-backends`;
  - `S-hosting-decision`: the comparison table and the corrections from the PR #16 review.
- [ECS task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
  (`stopTimeout`),
  [ECS service parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)
  (deployment percentages),
  [ECS circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html)
  (threshold),
  [ALB deregistration delay](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html#deregistration-delay),
  [`AWS::SSM::Parameter`](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ssm-parameter.html)
  (no SecureString),
  [AWS KMS Ed25519](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html),
  [EMF on ECS](https://docs.aws.amazon.com/prescriptive-guidance/latest/implementing-logging-monitoring-cloudwatch/metrics-for-amazon-ecs.html)
  (checked 2026-10-09 and 2026-10-12)
