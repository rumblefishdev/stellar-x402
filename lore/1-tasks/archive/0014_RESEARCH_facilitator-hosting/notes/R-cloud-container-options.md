---
title: "Cloud container hosting options"
type: research
status: mature
spawned_from: README.md
spawns:
  - S-hosting-decision.md
tags: [hosting, aws, gcp, azure, kms]
links: []
history:
  - date: "2026-10-08"
    status: developing
    who: claude
    note: "Researched for 0014 (ECS Fargate, Cloud Run, Azure Container Apps, managed Kubernetes)."
  - date: "2026-10-09"
    status: mature
    who: stkrolikiewicz
    note: "Moved from an untracked checkout into the branch; feeds S-hosting-decision and ADR 0011."
---

# Cloud container hosting options

Research for task 0014. It compares hosting the facilitator on:

- AWS ECS on Fargate, with an "AWS in depth" section, because AWS is Rumble Fish's default cloud
- Google Cloud Run
- Azure Container Apps
- managed Kubernetes (EKS/GKE)

It also covers KMS support for the Stellar Ed25519 key. All prices are on-demand list prices in USD, checked on 2026-10-08, for 730 hours a month. AWS rates are for Frankfurt (eu-central-1) and come from the AWS Price List API files linked inline. Anything I couldn't confirm from a primary source is marked **unverified**. Cost totals are my own arithmetic.

## What drives the comparison

These are the requirements from the task, AD-12, AD-15, AD-17 and the spine's "Deferred" section that rule platforms in or out:

- **No scale to zero.** The process must keep CPU between requests for the confirmation loop and the ledger clock.
- **Stop before start (AD-17).** One process per channel set. The old process must stop before the new one takes the lease, so rolling overlap is not allowed.
- **Grace period of at least 90–120 s.** One settlement can take about 90 s with the pool's defaults, so SIGTERM → SIGKILL has to allow that.
- **Long HTTP requests.** If `/settle` waits for the result, every proxy in front needs a timeout above about 120 s.
- **Public HTTPS URL** for the AD-15 gate proxy. A platform default URL is enough for T1. A custom domain is nice to have.
- **Mainnet later:**
  - 99%+ uptime
  - possibly N instances, each with its own channel set
  - the Ed25519 facilitator key ideally held in a KMS

## 1. AWS ECS on Fargate (with an ALB)

- **Fit for a long-lived process:** good.
  - A service with `desiredCount: 1` keeps one task running all the time.
  - Fargate bills per vCPU-second and GB-second whether or not requests arrive, so the background loop always has CPU.
  - Frankfurt rates: x86 $0.04656 per vCPU-hour and $0.00511 per GB-hour; ARM $0.03725 and $0.00409 ([Price List: AmazonECS eu-central-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-central-1/index.json), [Fargate pricing](https://aws.amazon.com/fargate/pricing/)).
- **Deploy strategy:** stop-before-start is supported natively. Details in [AWS in depth: deploy mechanics](#a2-deploy-mechanics-on-ecs-stop-before-start).
  - **Config:** `deploymentConfiguration.minimumHealthyPercent = 0` and `maximumPercent = 100`.
  - `maximumPercent` caps the tasks that are RUNNING, STOPPING or PENDING during a deployment. With one task, the new task can't start until the old one has fully stopped ([ECS service definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)).
- **Grace period:**
  - `stopTimeout` defaults to 30 s, and **the maximum on Fargate is 120 s** ([task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)).
  - Before SIGTERM, the task is deregistered from the ALB target group (DEACTIVATING, then STOPPING) ([task lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)).
  - That deregistration delay (default 300 s) lets in-flight HTTP requests finish before SIGTERM is sent ([target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)).
  - The 120 s cap just meets the 90–120 s requirement. There is no headroom above 120 s after SIGTERM.
- **Managed Postgres and Redis:** RDS for PostgreSQL, Aurora Serverless v2, Aurora DSQL and ElastiCache (Valkey). See [A3](#a3-managed-postgres-and-redis-on-aws).
- **Secrets and KMS:**
  - Secrets Manager and SSM Parameter Store values are injected as environment variables through the task definition's `secrets` (see [A4](#a4-secrets-secrets-manager-vs-parameter-store)).
  - AWS KMS supports Ed25519 natively (see [KMS and Ed25519](#kms-and-ed25519)).
- **TLS and custom domain:**
  - The ALB terminates TLS with a free ACM certificate ([ACM pricing](https://aws.amazon.com/certificate-manager/pricing/)).
  - A plain ALB has no default HTTPS hostname we can certify, so it needs a domain. See [A1](#a1-compute-choices-for-one-always-on-container).
  - **The ALB idle timeout defaults to 60 s.** Raise it to at least 180 s for `/settle`. The allowed range is 1–4000 s ([ALB attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)).
- **Logs, metrics and alerting:**
  - **Logs:** the `awslogs` driver sends them to CloudWatch Logs. Frankfurt ingest is $0.63/GB, storage $0.0324/GB-month, and retention is set per log group.
  - **Metrics and alarms:** custom metrics cost $0.30/metric-month (first 10k) and alarms $0.10/alarm-month ([Price List: AmazonCloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-central-1/index.json), [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)).
  - **OTel:** possible through the AWS Distro for OpenTelemetry collector as a sidecar ([ADOT on ECS](https://aws-otel.github.io/docs/setup/ecs)).
  - **Slack:** see [A6](#a6-alerting-to-slack).
- **Regions:**
  - Frankfurt (eu-central-1) is the nearest full region.
  - Warsaw has an AWS Local Zone, `eu-central-1-waw-1`, parented to Frankfurt ([GA announcement, 2022-10-27](https://aws.amazon.com/about-aws/whats-new/2022/10/announcing-general-availability-aws-local-zones-hamburg-warsaw/)). Whether Fargate and RDS run there is **unverified**. Treat it as EC2-only.
- **Cost:** T1 is about $70/month; mainnet-ish is about $185–315/month. The breakdown is in [A7](#a7-monthly-bill-ecs-on-fargate).
- **Testnet → mainnet carry-over:**
  - The same IaC stack, task definition shape, pipeline and alarms, parameterised per network.
  - **Changes for mainnet:**
    - the signer moves from an env secret to KMS
    - RDS moves to Multi-AZ
    - `desiredCount` becomes N, with N channel sets
    - optionally private subnets with a NAT gateway, and WAF
- **Team effort:** moderate.
  - Needs IaC: CDK in TypeScript or Terraform.
  - Needs a GitHub Actions OIDC deploy role. See [A8](#a8-team-effort-iac-and-ci).

**AWS App Runner:**

- Closed to new customers. Existing customers can keep using it, but no new features are planned. AWS points to ECS Express Mode instead ([App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)).
- The cut-off date is 2026-04-30 ([AWS Support on X](https://x.com/AWSSupport/status/2043243058402046237)).
- No official end-of-life date was found.
- Not an option for a new service.

## AWS in depth

### A1. Compute choices for one always-on container

| Option | Stop-before-start | Max SIGTERM grace | HTTPS URL with no own domain | T1 compute + fixed network cost/month |
|---|---|---|---|---|
| **ECS on Fargate + ALB** (standard service) | **Yes**, with `minimumHealthyPercent=0` and `maximumPercent=100` | **120 s** `stopTimeout`, after ALB deregistration (up to the deregistration delay) | **No.** Needs a domain plus an ACM cert on the ALB | ~$48–52: task $16.6 (ARM, 0.5 vCPU/1 GB) + ALB $19.7 + about 0.2–1 LCU ($1–6) + 2 ALB IPv4 $7.3 + task IPv4 $3.65 |
| **ECS Express Mode** | **No.** Canary only, and the strategy can't be changed | 120 s (task-definition `stopTimeout`; Express default is 30 s) | **Yes.** AWS-managed `*.ecs.<region>.on.aws` URL with an ACM cert | Same as the row above. The ALB is shared by up to 25 Express services |
| **App Runner** | n/a | n/a | n/a | **Closed to new customers since 2026-04-30** |
| **Lightsail containers** | **No** (inferred). A new deployment becomes ACTIVE only after its health checks pass, while the old one keeps serving | Not documented (**unverified**) | **Yes.** `https://<svc>.<guid>.<region>.cs.amazonlightsail.com` | Micro (0.25 vCPU/1 GB) about $9.8; Small (0.5 vCPU/1 GB) about $14.7; LB and TLS included |
| **Single EC2 instance + Docker** | **Yes.** Our own script stops the old container before starting the new one | Any (`docker stop -t`, compose `stop_grace_period`) | **Only with an IP cert.** Let's Encrypt short-lived IP certs (160 h) are GA since 2026-01-15; otherwise a domain is needed | t4g.small $14.0 + 20 GB gp3 $1.9 + IPv4 $3.65 ≈ $19.6 (t4g.micro ≈ $12.6) |

Sources for the table rows:

- **ECS on Fargate + ALB** (deploy config, grace period, IPv4 charge):
  - [ECS service params](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)
  - [task def params](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
  - [Price List: ELB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-central-1/index.json)
  - [Price List: VPC (public IPv4 $0.005/h)](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-central-1/index.json)
- **ECS Express Mode:**
  - [Express Mode resources](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html): canary only, strategy not updatable, ALB shared by up to 25 services, ACM cert created
  - [re:Post on the default `*.ecs.<region>.on.aws` URL](https://repost.aws/articles/ARDZrGhYT1SMCAeGbojOMbsg/re-invent-2025-launch-web-applications-in-seconds-with-amazon-ecs-express-mode)
- **App Runner:** [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).
- **Lightsail containers:**
  - [deployment states (ACTIVE/INACTIVE/FAILED)](https://docs.aws.amazon.com/en_us/cli/latest/reference/lightsail/get-container-service-deployments.html)
  - [default domain](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-point-domain-to-container-service.html)
  - [Price List: Lightsail](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonLightsail/current/eu-central-1/index.json)
- **Single EC2 instance + Docker:**
  - [EC2 on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/): t4g.micro $0.0096/h, t4g.small $0.0192/h, gp3 $0.0952/GB-month, read from the eu-central-1 Price List CSV
  - [Let's Encrypt IP certificates GA](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
  - [docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)
  - [compose stop_grace_period](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)

Notes on each choice:

- **ECS on Fargate + ALB.** This is the only managed AWS option that supports stop-before-start, a 120 s grace period, IAM task roles (so the task can call KMS) and Multi-AZ, all together.
  - **Default URL.** The ALB's default `*.elb.amazonaws.com` name can't carry a publicly trusted cert. My inference: ACM validates domain control, and we don't control `amazonaws.com`.
  - **So:** use a company subdomain with ACM DNS validation. Using Route 53 costs $0.50/month per hosted zone ([Route 53 pricing](https://aws.amazon.com/route53/pricing/)).
- **CloudFront in front of the ALB** would give a free `*.cloudfront.net` HTTPS name. But the origin response timeout:
  - defaults to 30 s
  - is limited to 60 s unless a quota increase is approved
  - can't go above 180 s even then

  ([re:Post](https://repost.aws/knowledge-center/cloudfront-custom-origin-response)). That is risky for a ~90 s `/settle`, so not recommended.
- **ECS Express Mode** is the quickest way to get an HTTPS URL. But canary deployments run old and new tasks side by side and shift 5% of traffic to the new one, which conflicts with AD-17 (see the deadlock analysis in A2).
- **Lightsail** is cheap and gives HTTPS out of the box. Concerns:
  - The deploy model overlaps old and new.
  - The grace period is undocumented.
  - I found no IAM-role support for containers, which would mean static access keys for KMS (**unverified**).
  - It is not a good path to mainnet.
- **EC2 + Docker** is the cheapest and gives full control: stop-then-start, any grace period, Caddy or another proxy for TLS. The cost is that we take on:
  - OS patching
  - restarts, unless the instance sits in an Auto Scaling group of 1
  - a single AZ
  - our own deploy script

  It is fine for a T1 stopgap, but most of it would be rewritten for mainnet.

### A2. Deploy mechanics on ECS (stop-before-start)

**Recommended service settings (T1, one task):**

- `desiredCount: 1`, `minimumHealthyPercent: 0`, `maximumPercent: 100`. Tasks in STOPPING count against `maximumPercent`, so ECS launches the replacement only after the old task is STOPPED ([service params](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)).
- `stopTimeout: 120` in the container definition. That is the Fargate maximum ([task def params](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)).
- ALB target group `deregistration_delay.timeout_seconds` of about 120 s. The ALB stops sending new requests to a deregistering target, and deregistration ends early if no requests are in flight ([target group attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)).
- ALB `idle_timeout.timeout_seconds` of at least 180 s ([ALB attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)).
- `healthCheckGracePeriodSeconds` longer than the lease TTL. This matters when the old task died without releasing the lease ([service params](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html)).

**What happens on a deploy:**

1. The old task is deregistered from the target group. New requests stop arriving, and in-flight `/settle` calls continue for up to the deregistration delay.
2. The old task gets SIGTERM, and our shutdown runs (stop `/settle`, drain, release the lease).
3. After up to 120 s it gets SIGKILL ([task lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)).
4. The old task reaches STOPPED.
5. The new task is provisioned, takes the lease, and passes the ALB health check.

Expect a few minutes of downtime per deploy. That is acceptable for T1. Note that in step 2 the shutdown hook only sees SIGTERM after deregistration, so the drain window after SIGTERM is still capped at 120 s.

**Readiness and the lease (deadlock analysis):**

- **With min 0 / max 100:** there is no overlap, so there is no deadlock even if the health check depended on the lease.
- **I still recommend** keeping the ALB health check on "process up" and returning 503 from `/settle` while the lease isn't held, with an alarm on "lease not held". Otherwise a short database outage would make ECS replace a healthy task.
- **With the ECS defaults (min 100 / max 200):** ECS starts the new task first and waits for it to become healthy.
  - If health depends on the lease, the new task never becomes healthy (the old task still holds the lease), and the deployment fails or rolls back.
  - If health doesn't depend on the lease, the ALB sends part of the `/settle` traffic to a task that returns 503 until the old task is gone.
  - Either way the defaults must be changed.
- **ECS Express Mode (canary only) has the same problem** ([Express Mode resources](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html)).
  - **With a lease-dependent health check**, the canary task never becomes healthy and the deployment rolls back.
  - **Without one**, 5% of traffic gets 503 during the bake. Express Mode's "faulty deployment" alarm may then roll it back.

**Mainnet with N instances (inference from the same parameters):**

- Run N tasks and N channel sets, one lease per set. Each task takes any free lease at start.
- Set `minimumHealthyPercent` to (N−1)/N and `maximumPercent` to 100. ECS then stops one task, waits until it is STOPPED, and starts its replacement, which takes the freed lease.
- This is a rolling deploy with no overlap on any channel set and no full outage.
- Example: with N=2, 50/100 keeps one task serving while the other is replaced.

### A3. Managed Postgres and Redis on AWS

Frankfurt prices are from the [Price List: AmazonRDS eu-central-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-central-1/index.csv) (also on the [RDS for PostgreSQL pricing page](https://aws.amazon.com/rds/postgresql/pricing/)).

| Choice | Hourly | Storage | ≈ Monthly |
|---|---|---|---|
| RDS PostgreSQL db.t4g.micro (2 vCPU burstable, 1 GB), Single-AZ | $0.019 | 20 GB gp3 at $0.137 | **$16.6** |
| RDS db.t4g.small (2 GB), Single-AZ | $0.037 | 20 GB gp3 | $29.8 |
| RDS db.t4g.small, Multi-AZ | $0.074 | 50 GB gp3 Multi-AZ at $0.274 | **$67.7** |
| RDS db.t4g.medium (4 GB), Multi-AZ | $0.149 | 50 GB gp3 Multi-AZ | $122.5 |
| RDS db.m8g.large, Multi-AZ | $0.40 | 50 GB gp3 Multi-AZ | ~$306 |
| Aurora Serverless v2 at 0.5 ACU minimum | $0.14/ACU-h | $0.119/GB-month + $0.22 per million I/Os | ≥ **$51** + storage |

Notes:

- **RDS backups:**
  - Storage beyond the free allocation costs $0.103/GB-month.
  - Burstable T4g instances bill CPU credits at $0.075/vCPU-hour if they run above their baseline in unlimited mode (Price List, same file).
- **Aurora Serverless v2 has been able to scale to 0 ACU since 2024-11-20.** It pauses after a period with no connections and resumes in about 15 s ([What's New](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-aurora-serverless-v2-scaling-zero-capacity)).
  - Our process renews its lease continuously and keeps connections open, so the database would never pause.
  - The realistic floor is 0.5 ACU, about $51/month, which is more than an RDS micro.
- **Aurora DSQL** is serverless and PostgreSQL-compatible.
  - **Availability:** Frankfurt since 2025-10-23 ([What's New](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-aurora-dsql-available-in-frankfurt)).
  - **Pricing:** DPUs plus storage, with a free tier of 100k DPUs and 1 GB a month ([DSQL pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/)). The Frankfurt per-DPU rate is **unverified**; third parties quote $8 per million DPUs for us-east-1.
  - **Concurrency:** optimistic concurrency only. A conflicting transaction fails with SQLSTATE 40001 and must be retried ([concurrency control](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-concurrency-control.html)).
  - **Limits:**
    - no temporary tables or triggers
    - at most 3,000 modified rows per transaction
    - connections time out after 1 h

    ([unsupported features](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html)).
  - **Recent additions:** foreign keys since 2026-08 ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/08/aurora-dsql-foreign-key-constraints/)).
  - Compare-and-set writes and the lease fit OCC. Whether advisory locks work is **unverified**.
  - It is an interesting option for 0013 but not plain Postgres.
- **Redis/Valkey for rate-limit counters:**
  - ElastiCache Valkey `cache.t4g.micro` is $0.0144/h, about $10.5/month.
  - Valkey Serverless is $0.101/GB-hour plus $0.0027 per million ECPUs ([Price List: ElastiCache eu-central-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/eu-central-1/index.csv), [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/)).
  - Its minimum billed storage is **unverified**.
  - At T1 the counters can live in Postgres.
- **Warsaw:** there is no full AWS region in Poland, only the Warsaw Local Zone (see section 1). Frankfurt is the practical choice.

### A4. Secrets: Secrets Manager vs Parameter Store

- **ECS integration:** both are referenced the same way, through `secrets[].valueFrom` in the container definition, by secret ARN or parameter ARN or name ([ECS TaskDefinition Secret](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ecs-taskdefinition-secret.html)).
  - The task execution role needs read access, and `kms:Decrypt` if a customer-managed key encrypts the value.
  - Values are resolved when the task starts, so a rotated value needs a new deployment. This is general ECS behaviour; the timing detail is **unverified**.
- **Secrets Manager:**
  - **Cost:** $0.40 per secret per month plus $0.05 per 10k API calls ([Price List](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSSecretsManager/current/eu-central-1/index.json), [pricing](https://aws.amazon.com/secrets-manager/pricing/)).
  - **Extras:** rotation and cross-account sharing, which we don't need.
- **Parameter Store `SecureString`:**
  - **Cost:** standard parameters have no monthly charge. Advanced parameters are $0.05/month, and higher-throughput API calls are $0.05 per 10k ([Price List](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSSystemsManager/current/eu-central-1/index.json), [Systems Manager pricing](https://aws.amazon.com/systems-manager/pricing/)).
  - Enough for `FACILITATOR_SECRET` on testnet.
- **Suggestion:**
  - **T1:** Parameter Store `SecureString`, with one testnet secret. Cost is about $0.
  - **Mainnet:** no secret at all. The signer calls KMS, and the task role is allowed `kms:Sign` on one key.

### A5. KMS (AWS)

- The key spec is `ECC_NIST_EDWARDS25519`, with signing algorithm `ED25519_SHA_512` and `MessageType: RAW`. It launched on 2025-11-07 in all regions.
- Cost: $1 per key per month plus $0.15 per 10k asymmetric requests in Frankfurt.
- Full detail and the Stellar fit are in [KMS and Ed25519](#kms-and-ed25519).

### A6. Alerting to Slack

- **Path:** a CloudWatch alarm publishes to an SNS topic, and that topic goes to Slack through "Amazon Q Developer in chat applications".
- **Rename:** this is the former AWS Chatbot, renamed on 2025-02-19. Service principals, IAM and integrations are unchanged ([What's New](https://aws.amazon.com/about-aws/whats-new/2025/02/aws-chatbot-named-amazon-q-developer/), [DevOps blog](https://aws.amazon.com/blogs/devops/aws-chatbot-is-now-named-amazon-q-developer/)).
- **Cost:** the chat integration has no extra charge ([DevOps blog](https://aws.amazon.com/blogs/devops/aws-chatbot-is-now-named-amazon-q-developer/)).
  - Alarms cost $0.10 per alarm per month (Price List: CloudWatch, section 1).
  - SNS charges at this volume are negligible (**unverified**; [SNS pricing](https://aws.amazon.com/sns/pricing/)).
- **What to alarm on:** the AD-18 alerts can be emitted as custom metrics from `onEvent`, at $0.30 per metric per month:
  - budget near its limit
  - breaker open
  - low facilitator balance
  - quarantined channels
  - pending results
  - lease not held

### A7. Monthly bill (ECS on Fargate)

**T1 (testnet, one task, public subnets, no NAT gateway):**

| Item | $/month |
|---|---|
| Fargate ARM 0.5 vCPU / 1 GB | 16.6 |
| ALB hours, plus about 0.2–1 LCU | 19.7 + 1–6 |
| Public IPv4: 2 for the ALB, 1 for the task | 11.0 |
| RDS db.t4g.micro Single-AZ, 20 GB | 16.6 |
| Logs (about 2 GB), 5 alarms, Parameter Store, ECR (about 1 GB at $0.10/GB-month), Route 53 zone | ~3 |
| **Total** | **≈ $68–73** |

- **NAT gateway:** putting the task in a private subnet behind one adds $0.052/h, about $38/month, plus $0.052/GB processed ([Price List: EC2 eu-central-1](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-central-1/index.csv)).
- **Egress:** internet traffic is $0.09/GB beyond the global free tier ([Price List: AWSDataTransfer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/eu-central-1/index.json)). That is negligible at T1.

**Mainnet-ish (2 tasks at 1 vCPU / 2 GB, production Postgres):**

| Item | $/month |
|---|---|
| 2 × Fargate ARM 1 vCPU / 2 GB (x86: 2 × 41.5) | 66.3 |
| ALB including LCUs | ~25 |
| Public IPv4: 2 for the ALB, 2 for the tasks | 14.6 |
| RDS db.t4g.small Multi-AZ, 50 GB (or t4g.medium at 122.5) | 67.7 |
| KMS key plus about 200k signatures | ~4 |
| Logs (about 10 GB), alarms, metrics | ~10–15 |
| **Total** | **≈ $190–250** |
| Optional NAT gateways (private subnets, 1–2 AZs) | +38–76 |

### A8. Team effort: IaC and CI

- **AWS Copilot CLI is out of support since 2026-06-12.** The repo was archived, and AWS recommends ECS Express Mode or CDK instead ([AWS containers blog](https://aws.amazon.com/blogs/containers/announcing-the-end-of-support-for-the-aws-copilot-cli), [repo](https://github.com/aws/copilot-cli)). Don't use it.
- **CDK in TypeScript** matches the team's language.
  - `ApplicationLoadBalancedFargateService` sets up the VPC, ALB, ACM certificate, service and log group, and exposes `minHealthyPercent` and `maxHealthyPercent` ([CDK ecs-patterns](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedFargateService.html)).
  - RDS, KMS and alarms are separate constructs in the same app.
- **Terraform is equally fine.** The `aws_ecs_service` resource has `deployment_minimum_healthy_percent` and `deployment_maximum_percent` ([Terraform aws_ecs_service](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecs_service)).
  - Choose it if the company already keeps AWS state in Terraform. Whether it does is **unknown**.
- **CI:** GitHub Actions assumes an IAM role through OIDC, so there are no stored AWS keys ([GitHub OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)). The pipeline:
  1. build the image
  2. push it to ECR
  3. render and register the task definition
  4. `amazon-ecs-deploy-task-definition` with `wait-for-service-stability` ([action](https://github.com/aws-actions/amazon-ecs-deploy-task-definition))
- **Rough effort (my estimate):**
  - 2–4 days for someone new to CDK to get VPC, ALB, ECS, RDS, the OIDC role and the pipeline working on testnet
  - about 1 day more for alarms and Slack
  - mainnet is mostly a second stack instance with different parameters

## 2. Google Cloud Run (services, plus worker pools)

- **Fit for a long-lived process:** partial.
  - With instance-based billing, CPU is allocated for the whole life of the instance, and minimum instances require it ([container contract](https://docs.cloud.google.com/run/docs/container-contract)).
  - Minimum instances are best-effort: they can be restarted at any time or briefly drop below the target ([min instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)).
  - Max instances "can be exceeded for a brief period", so `max=1` does not guarantee a single instance ([max instances](https://docs.cloud.google.com/run/docs/configuring/max-instances)).
  - Below 1 vCPU, request-based billing is required, so 1 vCPU is the practical minimum ([CPU limits](https://docs.cloud.google.com/run/docs/configuring/cpu)).
- **Deploy strategy:** no stop-before-start.
  - A new revision gets traffic once it is Ready, and old and new can serve during the transition ([rollouts and traffic migration](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)).
  - Readiness probes are in Preview and run after the startup probe ([health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks)).
  - **With a lease-dependent startup or readiness probe:** the new revision never becomes Ready. The deploy fails and the old revision keeps serving, so the deploy is stuck rather than deadlocked forever.
  - **With a lease-independent probe:** traffic moves to an instance that returns 503 on `/settle` until the old instance gets SIGTERM and releases the lease.
- **Grace period:** **10 s from SIGTERM to SIGKILL, fixed.** This applies to services and worker pools alike ([container contract](https://docs.cloud.google.com/run/docs/container-contract)).
  - That is far below the required 90–120 s.
  - This is the deciding gap: in-flight settlements would be cut off on every deploy and on every platform restart. Startup recovery (AD-16) would clean up, but it breaks AD-17's shutdown rule.
- **Worker pools:**
  - Instances never idle and always have CPU.
  - They have **no HTTP endpoint or URL** ([deploy worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools)).
  - They also have the same 10 s grace period.
  - Their preview launched 2025-06-25 ([release notes](https://docs.cloud.google.com/run/docs/release-notes)); the GA date is **unverified**.
  - They can't serve the public facilitator URL.
- **Managed Postgres and Redis:**
  - **Cloud SQL shared-core** ([Cloud SQL pricing](https://cloud.google.com/sql/pricing)):
    - db-f1-micro (0.6 GB) is $0.0105/h, and db-g1-small (1.7 GB) is $0.035/h, at the default listed region.
    - Frankfurt db-g1-small is about $0.042/h ([Spare Cores](https://sparecores.com/database/gcp/db-g1-small), third-party).
    - Shared-core instances are not covered by the Cloud SQL SLA.
    - SSD storage is about $0.17/GB-month.
  - **Dedicated db-standard-1** (1 vCPU, 3.75 GB) is about $59/month for compute in Frankfurt or Warsaw ([Bytebase](https://www.bytebase.com/dbcost/cloudsql/instance/db-standard-1.md), third-party). HA roughly doubles that (**unverified**).
  - **Memorystore** is available; its price was not checked.
- **Secrets and KMS:**
  - Secret Manager values can be mounted as env vars or volumes. Its price was not checked (**unverified**).
  - Cloud KMS supports Ed25519 only at the SOFTWARE protection level (see the KMS section).
- **TLS and domain:**
  - **Default URL:** every service gets an HTTPS `*.run.app` URL, which is enough for T1.
  - **Domain mappings:**
    - are Preview and "not recommended for production"
    - are available only in europe-north1, europe-west1 and europe-west4 among EU regions; not Frankfurt or Warsaw

    ([mapping custom domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains)).
  - **Otherwise:** a global external Application Load Balancer. Its forwarding-rule cost, roughly $18/month, is **unverified**.
  - **Request timeout:** up to 60 min, default 5 min ([request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)).
- **Logs and metrics:**
  - Cloud Logging costs $0.50/GiB after 50 GiB per project per month, with 30 days of storage included ([Observability pricing](https://cloud.google.com/stackdriver/pricing)).
  - Cloud Monitoring alerting is built in.
  - OTel works through a collector sidecar.
- **Regions:** Warsaw (europe-central2) and Frankfurt (europe-west3) are both Tier 2. Belgium and the Netherlands are Tier 1 ([Cloud Run pricing](https://cloud.google.com/run/pricing), [locations](https://docs.cloud.google.com/run/docs/locations)).
- **Cost:**
  - **Rates:**
    - Tier 1 instance-based: $0.000018 per vCPU-second and $0.000002 per GiB-second.
    - Free tier: 240k vCPU-s and 450k GiB-s a month ([Cloud Run pricing](https://cloud.google.com/run/pricing)).
    - Tier 2 is about 20% higher: $0.0000216 and $0.0000024 (third-party tables, e.g. [economize.cloud](https://www.economize.cloud/resources/gcp/pricing/cloud-run/); **unverified**).
  - **T1** (1 vCPU, 512 MiB, always on, Frankfurt): about $55, plus Cloud SQL f1-micro and 10 GB at about $10. Total **≈ $65** (about $55 in Belgium).
  - **Mainnet-ish** (2 × 1 vCPU/2 GiB): about $134, plus Cloud SQL db-standard-1 HA and 50 GB at about $135, plus a global LB at about $18. Total **≈ $290** (partly **unverified**).
- **Testnet → mainnet carry-over:** the same service and pipeline. It changes to Cloud SQL HA and a load balancer for a custom domain.
- **Team effort:** low to set up with `gcloud run deploy`. The grace period and overlap would force design changes to AD-17.
  - New platform and account for the team (does a company GCP org exist? **unknown**).

## 3. Azure Container Apps (brief)

- **Fit:** OK.
  - With `minReplicas: 1` the app never scales to zero.
  - **Billing:** consumption billing charges an "active" rate, or an "idle" rate when a replica:
    - uses less than 0.01 vCPU
    - receives less than 1,000 bytes/s
    - serves no requests

    ([billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)). The background loop will often make the replica count as active.
- **Deploy strategy:**
  - **Single revision mode** (the default) keeps the old revision until the new one is provisioned and has passed its startup and readiness probes. Old and new overlap.
    - **If readiness depends on the lease,** the update fails and "traffic remains pointed to the old revision" ([revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions)). The deploy is stuck.
  - **Multiple revision mode** lets us deactivate revisions manually. A scripted "deactivate the old revision, then create the new one" would give stop-before-start with downtime. That this works cleanly is **unverified**.
- **Grace period:** the default is 30 s ([lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/application-lifecycle-management)).
  - `template.terminationGracePeriodSeconds` is configurable, but no maximum is documented ([ARM reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps)).
  - One user reported a 60 s setting not being honoured ([Q&A](https://learn.microsoft.com/en-us/answers/a/12485805)).
  - Whether 90–120 s works is **unverified**.
- **Ingress timeout:** a fixed 240 s request timeout, which is fine for ~90 s settles ([ingress overview](https://learn.microsoft.com/azure/container-apps/ingress-overview)).
- **Managed Postgres:**
  - Flexible Server Burstable B1ms is $0.0199/h. Storage is $0.137/GB-month, with a 32 GB minimum. Together that is **$18.9/month** in Poland Central ([Azure Retail Prices API](https://prices.azure.com/api/retail/prices)).
  - Zone-redundant HA isn't offered on Burstable, according to Microsoft Q&A answers ([Q&A](https://learn.microsoft.com/en-us/answers/questions/1662253/how-to-enable-azure-postgresql-flexible-server-to)).
  - General Purpose with 2 vCores is $0.212/h, so HA with 64 GB comes to about **$327/month**.
- **Secrets and KMS:**
  - Container Apps secrets can reference Key Vault through a managed identity ([manage secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)).
  - **Key Vault has no Ed25519** (see the KMS section).
- **TLS and domain:**
  - The default `*.azurecontainerapps.io` HTTPS URL is included.
  - Managed certificates for custom domains are free ([managed certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates)).
- **Logs and metrics:**
  - Log Analytics ingestion is $2.99/GB after 5 GB a month in Poland Central (Retail Prices API).
  - The managed OpenTelemetry agent "runs at no extra compute cost" ([billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)).
- **Region:** Poland Central (Warsaw). Container Apps and Postgres Flexible meters are listed there in the Retail Prices API.
- **Rates:** $0.000024 per vCPU-second active and $0.000003 idle; $0.000003 per GiB-second. The monthly free grant is 180k vCPU-s and 360k GiB-s (Retail Prices API, [billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)).
- **T1 cost** (0.5 vCPU/1 GiB): $6 if always idle to $34 if always active, plus Postgres B1ms at $19. Total **≈ $25–53**.
- **Mainnet-ish cost** (2 × 1 vCPU/2 GiB, active): about $152, plus GP Postgres HA at about $327. Total **≈ $480**.
- **Effort:** low to moderate, with Bicep or Terraform. But it is a third cloud with no Ed25519 KMS, which is the weakest key-custody story.

## 4. Managed Kubernetes (EKS / GKE), as the "company cluster" option

- **Fit:** good.
  - **Deployment with `strategy: Recreate`:** all old Pods are terminated before new ones are created ([Deployment Recreate](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment)).
  - **StatefulSet `RollingUpdate`:** each Pod is deleted and recreated one at a time, in reverse ordinal order ([StatefulSet rolling updates](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#rolling-updates)).
  - A StatefulSet maps naturally onto "ordinal i owns channel set i" for N instances on mainnet, with stop-before-start per channel set and no full outage.
- **Grace period:** `terminationGracePeriodSeconds` is set per Pod.
  - GKE Autopilot caps it at 600 s for most Pods and at 25 s for Spot Pods.
  - Autopilot node upgrades drain for up to 1 h ([Autopilot upgrades](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-upgrades-autopilot), [extended-duration Pods](https://cloud.google.com/kubernetes-engine/docs/how-to/extended-duration-pods)).
  - 120 s or more is easy.
- **Key custody:**
  - EKS can use AWS KMS (Ed25519 supported) through IAM roles for service accounts or Pod Identity.
  - GKE can use Cloud KMS (Ed25519, software keys only).
- **Cost:**
  - **EKS:** $0.10 per cluster-hour, about $73/month, before nodes, the ALB, NAT and so on. Clusters on versions in extended support pay $0.60/h ([EKS pricing](https://aws.amazon.com/eks/pricing/)).
  - **GKE:** $0.10 per cluster-hour, but a $74.40 monthly credit covers one zonal or Autopilot cluster per billing account ([GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)).
  - **A dedicated EKS cluster for T1** would cost **≈ $150/month**: control plane $73, plus a small node or Fargate pod at about $15–20, plus ALB and IPv4 at about $27, plus RDS at about $17.
  - **In an existing company cluster,** the marginal cost is only the Pod's resources and our share of the ingress.
- **Effort:**
  - **High for a new cluster:** control plane, ingress controller, cert-manager or ACM, ExternalDNS, upgrades, and an observability stack.
  - **Low only if a company cluster already exists** and someone else runs it. I found no evidence of one, so this is **unknown** and should be asked.

## KMS and Ed25519

How Stellar signs: the SDK builds the signature base (network ID, then envelope type, then transaction XDR) and takes its SHA-256. It then signs that **32-byte hash** with plain (pure) Ed25519 and attaches a decorated signature whose hint is the last 4 bytes of the public key ([py-stellar-base `BaseTransactionEnvelope`](https://stellar-sdk.readthedocs.io/en/3.2.1/_modules/stellar_sdk/base_transaction_envelope.html)). So a KMS must do **PureEdDSA over a 32-byte message**. HashEdDSA (Ed25519ph) gives a different, invalid signature.

| | AWS KMS | Google Cloud KMS | Azure Key Vault / Managed HSM |
|---|---|---|---|
| Ed25519 support | **Yes** | **Yes, SOFTWARE protection only** | **No** in Key Vault; Managed HSM not documented (treat as no) |
| Names | Key spec `ECC_NIST_EDWARDS25519`, key usage `SIGN_VERIFY`. Use **`ED25519_SHA_512` with `MessageType: RAW`** (PureEdDSA). `ED25519_PH_SHA_512` with `DIGEST` is HashEdDSA, so don't use it | Algorithm `EC_SIGN_ED25519` (`ec-sign-ed25519` in gcloud): "PureEdDSA mode, which takes raw data as input" | Key Vault EC curves are P-256, P-256K, P-384 and P-521 only (ES256/ES256K/ES384/ES512) |
| Launch | **2025-11-07**, all AWS regions including GovCloud and China (so including eu-central-1) | Release note **2024-04-15**; no preview label | — |
| Protection | Private key never leaves KMS unencrypted | The HSM and EXTERNAL tables don't list it, so it is software-backed | Ed25519 is supported on Azure Dedicated HSM (Thales Luna appliances), a separate service. A secondary source says it is closed to new customers (**unverified**) |
| Price | $1 per key per month + $0.15 per 10k asymmetric requests (Frankfurt) | About $0.06 per software key version per month + $0.03 per 10k signs (rate for Ed25519 **unverified**) | — |
| Throughput | ECC Sign/Verify share a default of 1,000 requests/s per account and region. Placing Ed25519 in that bucket is my inference | not checked | — |
| Fit for our signer | **Good.** Message = the 32-byte tx hash; output = a 64-byte signature. The public key comes from `GetPublicKey` | Usable, but not HSM-backed | Not usable |

Sources for the table, by column:

- **AWS KMS:**
  - [key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)
  - [What's New 2025-11-07](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/)
  - [Price List: KMS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/eu-central-1/index.json)
  - [request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)
  - [Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
  - [GetPublicKey API](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html)
- **Google Cloud KMS:**
  - [algorithms](https://docs.cloud.google.com/kms/docs/algorithms)
  - [release notes](https://docs.cloud.google.com/kms/docs/release-notes)
  - [Cloud KMS pricing](https://cloud.google.com/kms/pricing)
- **Azure:**
  - [Key Vault key types](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details)
  - [Managed HSM key types](https://learn.microsoft.com/en-us/azure/key-vault/managed-hsm/about-keys-details)
  - [azure-cli "Unsupported curve" issue](https://github.com/Azure/azure-cli/issues/26898)
  - [Java SDK OKP request closed](https://github.com/Azure/azure-sdk-for-java/issues/26329)
  - [Dedicated HSM FAQ](https://learn.microsoft.com/en-us/azure/dedicated-hsm/faq)

Practical notes for AWS:

- **A new key and address.**
  - A KMS-generated key can't be exported, so the mainnet facilitator address is whatever KMS generates.
  - Channels are then set up with that key as their only signer, which matches AD-12's `checkChannel`.
  - Whether Ed25519 key material can be imported into KMS is **unverified**.
- **The public key.** `GetPublicKey` returns DER `SubjectPublicKeyInfo`. The last 32 bytes are the raw Ed25519 key, which encodes to the G… address.
- **Latency.** Every Sign is a network call. Settlement latency goes up by one KMS round trip per signature, or two with a fee bump. The size of that round trip is **unverified**; measure it on testnet.

## Comparison table

| Option | Long-lived, background CPU | Stop-before-start | Max SIGTERM grace | HTTPS URL without own domain | Managed Postgres (smallest) | Ed25519 KMS | EU region near PL | T1 $/month | Mainnet-ish $/month | Effort |
|---|---|---|---|---|---|---|---|---|---|---|
| **AWS ECS Fargate + ALB** | Yes | **Yes** (min 0 / max 100; N tasks: (N−1)/N / 100) | **120 s** + ALB drain before it | No (domain + ACM) | RDS t4g.micro ≈ $16.6 | **Yes** (HSM-backed) | Frankfurt (Warsaw LZ, EC2) | **≈ 70** | **≈ 190–250** (+38–76 NAT) | Medium (CDK/Terraform + OIDC) |
| AWS ECS Express Mode | Yes | **No** (canary only) | 120 s (default 30) | Yes (`*.ecs.<region>.on.aws`) | RDS | Yes | Frankfurt | ≈ 70 | ≈ 190–250 | Low |
| AWS App Runner | — | — | — | — | — | — | — | closed to new customers | — | — |
| AWS Lightsail containers | Yes | No (inferred) | undocumented | Yes | Lightsail DB / RDS | Static keys only (**unverified**) | Frankfurt | ≈ 10–15 + DB | weak path | Low |
| AWS EC2 + Docker | Yes | Yes (own script) | any | Let's Encrypt IP cert, or a domain | RDS or self-run | Yes (instance role) | Frankfurt / Warsaw LZ | ≈ 20 (+17 RDS) | ≈ 150–200 (**unverified**) | Medium (own ops) |
| Google Cloud Run | Yes (instance billing, min 1, 1 vCPU) | **No** (revision overlap) | **10 s fixed** | Yes (`*.run.app`) | Cloud SQL f1-micro ≈ $10 (no SLA) | Software keys only | Warsaw, Frankfurt (Tier 2) | ≈ 55–65 | ≈ 290 (partly **unverified**) | Low setup; AD-17 changes |
| Azure Container Apps | Yes (min 1) | Not in single mode; scripted in multiple mode (**unverified**) | default 30 s, max undocumented | Yes (`*.azurecontainerapps.io`) | PG Flexible B1ms ≈ $19 | **No** | Poland Central (Warsaw) | ≈ 25–53 | ≈ 480 | Medium; third cloud |
| Managed K8s (EKS/GKE) | Yes | **Yes** (Recreate / StatefulSet) | configurable (GKE Autopilot ≤ 600 s) | No (Ingress + cert) | RDS / Cloud SQL | EKS: yes; GKE: software | Frankfurt / Warsaw | ≈ 150 dedicated EKS; marginal in a company cluster | ≈ 300+ dedicated | High (new cluster); low if one exists |

## Caveats and open questions

**Unverified facts:**

- **Lightsail:** grace period, IAM support and exact deploy semantics.
- **Azure Container Apps:** the maximum `terminationGracePeriodSeconds` and the multiple-revision stop-first script.
- **Google Cloud Run:** Tier 2 rates, Cloud SQL HA, the global LB price and the worker pools GA date.
- **AWS databases:** the DSQL Frankfurt DPU rate and the Valkey Serverless minimum.
- **KMS:** Ed25519 key import and Sign latency.

**Other caveats:**

- **The 120 s Fargate ceiling is tight.**
  - If settlements can exceed about 120 s after SIGTERM, shutdown must mark them pending and rely on AD-16 startup recovery.
  - ALB deregistration before SIGTERM helps only for in-flight HTTP requests, not for background confirmations.
- **Platform-initiated restarts.** Fargate task retirement for patching, Cloud Run instance restarts and Container Apps replica moves all happen outside our deploys. With min 0 / max 100 they stop the old task first, so there is a short outage. AWS's task-retirement mechanics are **unverified** here.
- **Health checks vs. the lease.** On every platform, keep liveness and readiness independent of the lease. Expose "lease held" as a metric and alarm instead. On overlapping platforms a lease-dependent probe blocks deploys. On ECS stop-first it would cause churn during DB blips.
- **Long-request timeouts:**
  - ALB idle timeout: default 60 s, so raise it.
  - CloudFront: 30/60/180 s limits.
  - Container Apps: 240 s, fixed.
  - Cloud Run: up to 60 min.
- **Open questions for the team:**
  - Which company AWS account or Organization do we use? Is there a separate account for mainnet?
  - Can we get a company subdomain for the facilitator? It is needed for ECS + ALB HTTPS.
  - Is there an existing company Kubernetes cluster?
  - Is Terraform already in use for company AWS infrastructure?
- **Region coordination with 0013.** If 0013 picks a non-AWS store (Neon, Supabase and so on), the database should still be in Frankfurt to keep latency low. A Postgres in Warsaw (Azure or GCP) adds cross-provider latency and egress.
