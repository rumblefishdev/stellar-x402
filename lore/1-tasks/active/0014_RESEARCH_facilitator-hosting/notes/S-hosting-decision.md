---
title: "Decision: ECS on Fargate in the company AWS account"
type: synthesis
status: mature
spawned_from: G-hosting-requirements.md
spawns: []
tags: [hosting, aws, ecs, decision]
links:
  - R-cloud-container-options.md
  - R-paas-and-vm-options.md
  - R-observability-backends.md
history:
  - date: "2026-10-09"
    status: mature
    who: stkrolikiewicz
    note: "Options compared on the requirements; ECS on Fargate chosen, recorded as ADR 0011."
---

# Decision: ECS on Fargate in the company AWS account

## Conclusion

The facilitator runs as one ECS service on Fargate per network, behind an ALB, in the company AWS
account that already runs sorobanscan and the Prices API. Logs, metrics and alerts stay in
CloudWatch. Recorded in [ADR 0011](../../../../../docs/adr/0011-facilitator-hosting.md).

## Comparison

Sources are in [R-cloud-container-options](R-cloud-container-options.md) (AWS in depth, Cloud
Run, Azure, Kubernetes, KMS), [R-paas-and-vm-options](R-paas-and-vm-options.md) (Fly.io, Railway,
Render, a single VM) and [R-observability-backends](R-observability-backends.md), plus the
2026-10-09 checks below. Testnet cost includes a managed Postgres where the platform has one,
since 0013 will likely need it.

### Checked again on 2026-10-09

The R- notes date from 2026-10-08. A second pass confirmed them and added:

- **Fly.io:** `fly deploy` creates two Machines by default (`--ha`, default true), which would
  break the lease; one Machine needs `--ha=false` or `fly scale count 1`.
  [flyctl deploy](https://docs.fly.io/flyctl/deploy)
- **Render:** a community report says the API rejects `maxShutdownDelaySeconds` on services with
  a disk, so stop-first (disk) and a long drain may not combine.
  [forum](https://community.render.com/t/specifying-max-shutdown-delay-seconds-for-services-with-disks/36752)
- **Railway:** `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0` still overlaps (staff answer, on their
  backlog). [forum](https://station.railway.com/questions/new-deployment-overlapping-with-old-one-9520b541)
- **ARM builds:** GitHub's `ubuntu-24.04-arm` runners are free for public repositories (GA
  2025-08-07), and this repo is public.
  [changelog](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)
- **Company AWS, by DNS:** `rumblefish.dev` has Route 53 name servers; sorobanscan is S3 +
  CloudFront; the Prices API is API Gateway answering from Frankfurt IPs.

| Criterion | ECS Fargate | EC2 + Docker | Fly.io | Render | Railway | Cloud Run |
|---|---|---|---|---|---|---|
| Long-lived, no idle throttling | yes | yes | yes (`auto_stop` off) | yes (paid) | yes | best effort |
| Stop-before-start | yes (min 0 / max 100 %) | our script | yes (1 Machine) | only with a disk | only with a volume | no |
| SIGTERM grace ≥ 90 s | 120 s max | any | 300 s max | 30 s with a disk (reported) | unproven with a volume | 10 s fixed |
| Managed Postgres | RDS, $14/mo | RDS, $14/mo | MPG, $38/mo | $6/mo | template container | Cloud SQL |
| Secrets | SSM / Secrets Manager | SSM | vault → env | env / files | sealed vars | Secret Manager |
| Ed25519 KMS (mainnet) | AWS KMS | AWS KMS | none | none | none | none checked |
| HTTPS URL | our domain + ACM | our domain | `*.fly.dev` | `*.onrender.com` | `*.up.railway.app` | `*.run.app` |
| Logs, metrics, alerts | CloudWatch, built in | CloudWatch agent | Prometheus; logs need a shipper | log streams | basic | Cloud Monitoring |
| EU region | Frankfurt | Frankfurt | fra, ams | Frankfurt | Amsterdam | Frankfurt |
| Testnet cost | ~$60–70/mo | ~$37/mo | ~$42/mo | fails | fails | fails |
| Testnet → mainnet | config | config | config | — | — | — |
| Team effort | IaC once, then CI | OS, deploy, recovery ours | low | — | — | — |
| Company default | yes | yes | new vendor | new vendor | new vendor | new vendor |

## Reasoning

1. **Only ECS on Fargate, EC2 and Fly.io meet both hard rules** (stop-before-start and a long
   drain). Render, Railway and Cloud Run each fail one or can't be shown to pass.
2. **AWS is the company default and already holds what we need.** The account and the
   `rumblefish.dev` zone are in place, and mainnet key custody (KMS Ed25519) comes from the same
   provider. Fly.io is cheaper and has a longer grace period, but is a new vendor with no KMS and
   an SLA only on Enterprise. That isn't enough reason to leave the default.
3. **Fargate over EC2:** AWS patches the host and replaces a failed task; on EC2 we would own the
   OS, the deploy script and recovery for ~$30/mo less.
4. **CloudWatch for logs, metrics and alerts,** not the Grafana Cloud Free stack that
   R-observability-backends leaned towards. Stan chose one vendor in the shared account: the hand-rolled JSON logger already writes the
   right shape to stdout, EMF turns metric lines into metrics with no SDK or agent, and alarms
   reach Slack through SNS. Nothing new to run.

## What it costs us

- **120 s is a hard ceiling** for the drain. The pool's 60 s + 30 s fits; raising
  `timeoutSeconds` past ~80 s would not.
- **Every deploy is 1–3 min of downtime.** Any stop-first host has this.
- **We need a domain** for HTTPS. `rumblefish.dev` is on Route 53, so a subdomain is likely; if
  not, CloudFront's default domain is the fallback.
- **SQLite would push us to EC2** (Fargate has only EFS). This feeds 0013.
