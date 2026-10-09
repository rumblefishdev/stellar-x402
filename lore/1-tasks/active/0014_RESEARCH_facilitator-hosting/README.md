---
id: "0014"
title: "Choose where the facilitator is hosted and record it in an ADR"
type: RESEARCH
status: active
milestone: 1
related_adr: ["0006", "0009", "0011"]
related_tasks: ["0012", "0013", "0025", "0026", "0027", "0036"]
tags: [facilitator, deploy, hosting, operations, priority-high, effort-small, platform]
links:
  - ../../../../deploy/README.md
  - ../../../../docs/runbook.md
  - ../../../../docs/monitoring.md
  - ../../../../docs/planning/m1-epics.md
  - ../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Spawned from the 0012 M1 architecture session: the hosting choice needs its own research."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Added the deploy, observability and public-URL requirements from the final M1 spine."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Tagged Platform lane by 0012; decision task feeding M1 Epic 2."
  - date: "2026-10-08"
    status: active
    who: stkrolikiewicz
    note: "Started by the Platform lane owner."
  - date: "2026-10-08"
    status: active
    who: stkrolikiewicz
    note: >
      Requirements written (notes/G-hosting-requirements.md); AWS is the company default cloud.
      Paused behind 0017, whose in-memory fakes the other lanes wait on. The option research keeps
      running in the background.
  - date: "2026-10-09"
    status: active
    who: stkrolikiewicz
    note: >
      Resumed after 0017 merged. The 2026-10-08 research notes (R-cloud-container-options,
      R-paas-and-vm-options, R-observability-backends) checked again and compared in
      S-hosting-decision; ECS on Fargate in the company AWS account chosen and
      recorded as ADR 0011, with CloudWatch logs, EMF metrics and alarms to Slack. Follow-ups
      handed to 0013, 0025, 0026 and 0027; the mainnet KMS signer spike spawned as 0036.
---

# Choose where the facilitator is hosted and record it in an ADR

## Summary

Research where the facilitator service runs, pick a hosting platform and a container setup, and
record the choice in an ADR. The T1 gate needs a public testnet facilitator, so this can't wait
for the mainnet milestone as `deploy/README.md` currently says.

## Context

- **T1 gate:** the canonical x402 e2e client completes `exact` verify → settle against our testnet
  facilitator, through a proxy under `e2e/facilitators/external-proxies/` that forwards to our
  public URL.
- **What runs:** one Node 22 service (Express 5). It holds:
  - the channel pool (long-lived process, background confirmation, a ledger clock)
  - verify and settle
  - Bazaar `resources`
- **State:** the store is chosen in 0013. Hosting and store choices affect each other: a managed
  database, a persistent volume and a network path all depend on the host.
- **Secrets:** the facilitator key signs every settlement (channels and fee bumps). Testnet and
  mainnet never share keys (`deploy/README.md`).
- **Later needs:** mainnet, uptime target 99%+ (`docs/monitoring.md`), more than one instance
  possible, metrics and alerts from `onEvent`.
- **From the final M1 spine:**
  - one process owns a network's channel set through a lease, so deploys must stop the old
    process before the new one starts, with no rolling overlap (AD-17);
  - the logger, metrics and alert backend are chosen here;
  - the e2e gate proxy needs a public HTTPS URL (AD-15).

## Implementation Plan

### Step 1: Requirements

- Separate T1 needs (testnet, one instance, public HTTPS URL, cheap) from mainnet needs (uptime,
  more than one instance, key custody, monitoring).
- Long-lived process: the pool must not be scaled to zero or killed mid-settlement. Note what
  this rules out (e.g. serverless functions).
- Secret handling for the facilitator key: env secrets versus a KMS; the pool's
  `TransactionSigner` is already KMS-pluggable.
- Find out whether there is a team or company default platform or an existing account.
- From 0017: logs must not carry RPC URLs as they are, since an RPC URL can hold an API key.
  The platform's log pipeline also decides the logger backend: 0017's `jsonLogger` writes JSON
  lines to stdout by hand; switch to pino if transports or redaction need it.

### Step 2: Compare options

- At least three, for example:
  - a PaaS (Fly.io, Railway or Render)
  - a cloud container service (AWS ECS/Fargate or GCP Cloud Run with min instances)
  - a company Kubernetes cluster, if one exists
- Criteria:
  - fit for a long-lived process
  - managed database option (for 0013)
  - secrets and KMS support
  - TLS and a custom domain
  - logs and metrics
  - region
  - cost on testnet and mainnet
  - how much carries over unchanged from testnet to mainnet
  - effort for the team
- Check current pricing and features on the web.
- Record findings as R- and S- notes in `notes/`.

### Step 3: Decide and record

- Pick the platform and the container setup (Dockerfile, image registry, deploy trigger).
- Write the ADR in `docs/adr/` with the next free number. It must include:
  - context
  - options considered
  - the decision, with the reasons it beats the alternatives
  - consequences (cost, key handling, path to mainnet)
- Update `deploy/README.md` so it no longer says hosting is chosen in the mainnet milestone.

## Acceptance Criteria

- [x] T1 and mainnet hosting requirements written down
- [x] At least three options compared against the criteria above, with sources
- [x] Platform and container setup chosen, including stop-before-start deploys
- [x] Logger, metrics and alerting backend chosen
- [x] ADR in `docs/adr/` documenting the decision and explaining why it was made over the
      alternatives, linked from this task's `related_adr`
- [x] `deploy/README.md` and the 0012 architecture spine updated to reference the ADR

## Implementation Notes

- **Notes:** `G-hosting-requirements` (what the host must do), `R-cloud-container-options` (ECS
  Fargate and the rest of AWS, Cloud Run, Azure, Kubernetes, KMS and Ed25519),
  `R-paas-and-vm-options` (Fly.io, Railway, Render, a single VM), `R-observability-backends`
  (logger, metrics, alerting, uptime), `S-hosting-decision` (criteria table and the 2026-10-09
  re-check). The three R- notes were written on 2026-10-08 and sat untracked in the main checkout
  until this session moved them in.
- **ADR:** [0011](../../../../docs/adr/0011-facilitator-hosting.md). `deploy/README.md` and the
  spine's Deferred section and ADR table point to it.
- **Handed on:** 0026 (Dockerfile, CDK stack, `/health`, deploy workflow, domain), 0027 (EMF
  adapter, alarms, Slack, uptime check), 0013 (RDS Postgres fits, SQLite means EC2), 0025 (drain
  inside 120 s).

## Design Decisions

### From Plan

1. **ECS on Fargate, one service per network**, `minimumHealthyPercent` 0 and `maximumPercent`
   100 for stop-before-start, `stopTimeout` 120 s. AWS is the company default and meets both
   hard rules; Fly.io was the only close alternative (S-hosting-decision).
2. **CloudWatch for logs, metrics and alerts**: stdout JSON through `awslogs`, EMF lines for
   metrics, alarms → SNS → Amazon Q Developer in chat applications → Slack.
3. **Secrets from SSM Parameter Store, KMS for mainnet**: the testnet key is a SecureString
   injected by the task definition; mainnet moves it into AWS KMS (Ed25519) behind the pool's
   `TransactionSigner`.

### Emerged

4. **`GET /health` checks nothing but the HTTP server.** Not in the plan. A health check on the
   lease, RPC or store would make ECS restart the task in a loop during an outage; the uptime
   check uses the public `/supported` instead.
5. **ARM64, 0.25 vCPU / 0.5 GB to start.** 20% cheaper than x86, and the repo is public, so
   GitHub's `ubuntu-24.04-arm` runner builds natively for free.
6. **AWS CDK in TypeScript** for the infrastructure. Stan didn't know the company's tool and let
   the ADR pick; CDK keeps one language and package manager. Swappable for Terraform.
7. **SSM Parameter Store over Secrets Manager**: free, and we don't use rotation functions.
8. **A public subnet with a task public IP** instead of a NAT gateway ($38/mo saved); the
   security group admits only the ALB.
9. **The hand-rolled `jsonLogger` stays** (no pino): stdout is the only transport. RPC URLs are
   logged by host only (the 0017 item).
10. **A `rumblefish.dev` subdomain** (proposed `testnet.x402.rumblefish.dev`), with CloudFront's
    default domain as the fallback. The zone is on Route 53 (checked by DNS); access is 0026's
    question.
11. **Region eu-central-1 as a stack parameter.** Stan doesn't know the account's region yet; the
    Prices API answers from Frankfurt IPs, so it's the default, not a fixed choice.
12. **Testnet deploys on every push to `develop`.** Each deploy is 1–3 min of downtime, so gate
    runs avoid merge times; mainnet deploys by hand.
13. **Same AWS account as sorobanscan and the Prices API, no shared compute.** Stan decided the
    account. From outside, sorobanscan is S3 + CloudFront and the Prices API is API Gateway, so
    there is no container platform to join. The facilitator holds a hot signing key, so its
    testnet and mainnet stacks get their own roles and secret paths, and the mainnet KMS key
    policy admits only the mainnet task role. The original idea of a separate mainnet account is
    dropped.

14. **CloudWatch over Grafana Cloud Free.** R-observability-backends leaned towards Grafana
    Cloud Free ($0, portable); Stan chose CloudWatch to stay with one vendor in the shared
    account. Grafana is recorded in the ADR as a rejected alternative.

## Issues Encountered

- **App Runner closed to new customers on 2026-04-30,** and its successor, ECS Express Mode, only
  does canary deploys. Both overlap old and new tasks.
- **Fargate's 120 s `stopTimeout` is a hard ceiling,** so the drain has no headroom past the
  pool's 60 s + 30 s.
- **An ALB's default name can't get an ACM certificate,** so HTTPS on AWS needs our domain or a
  CloudFront front.
- **Cloud Run's 10 s SIGTERM grace is fixed,** which rules it out outright.
- **`fly deploy` creates two Machines by default,** which would break the lease on day one.
- **The KMS Ed25519 output encoding isn't documented** (expected raw 64 bytes); 0036 proves it.

## Future Work

- Mainnet KMS signer spike → 0036.
