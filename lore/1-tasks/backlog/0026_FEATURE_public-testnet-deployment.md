---
id: "0026"
title: "Public testnet deployment"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011", "0012"]
related_tasks: ["0012", "0014", "0022", "0017", "0020", "0013"]
tags: [facilitator, deploy, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.5 (Platform lane)."
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "Added where RPC_URLS lives and keeps its old values, from Stan's PR #41 review."
---

# Public testnet deployment

## Summary

As a anyone integrating with or testing the facilitator, including the gate, I want the facilitator at a public HTTPS testnet URL, so that the e2e proxy and real resource servers can reach it.

**Story:** [M1 Story 2.5](../../../docs/planning/m1-epics.md#story-25-public-testnet-deployment) · **Lane:** Platform · **Covers:** FR21 prerequisite; NFR4, NFR9

## Context

- Needs the 0014 hosting ADR and the 0022 adapters.
- Related tasks: 0014, 0022, 0017.

## Implementation

- Dockerfile, image build and the deploy trigger from 0014.
- Secrets and stores configured on the platform; runbook updated.
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)), the service: ECS on Fargate in the account
  that runs sorobanscan and the Prices API.
  - One service, `desiredCount` 1, `minimumHealthyPercent` 0, `maximumPercent` 100,
    `stopTimeout` 120.
  - The circuit breaker rolls back, with a threshold of one failed task (`thresholdConfiguration`;
    use the ECS API if CDK doesn't expose it yet).
  - The ALB is HTTPS only, with `SslPolicy.RECOMMENDED_TLS` or newer, idle timeout 120 s and
    deregistration delay 100 s.
  - The target health check is `/health` every 10 s, 2 checks to pass and 3 to fail.
  - `TRUSTED_PROXY_HOPS=1`.
  - Node `keepAliveTimeout` is 125 s, with `headersTimeout` above it.
- From 0014, the image:
  - `pnpm deploy --prod` with `injectWorkspacePackages: true` in `pnpm-workspace.yaml`;
  - `"files": ["dist"]` in `apps/facilitator/package.json` and a `.dockerignore` that excludes
    `.env*`;
  - `node:22-slim` pinned by digest, user `node`, read-only root filesystem, ECS Exec off;
  - one ECR repository for both networks: immutable SHA tags, scan on push, a lifecycle rule
    that keeps rollback images. The workflow skips the build when the SHA exists.
- From 0014, the infrastructure: CDK with its own bootstrap qualifier.
  - An infra stack (VPC, ALB, certificate, DNS, KMS key, roles), applied by a person.
  - A service stack (task definition and service, image digest as a parameter), applied by the
    workflow. Its execution policy covers only ECS, its log group and passing the two roles.
  - No `amazon-ecs-deploy-task-definition`: the service stack is the only owner of the task
    definition.
- From 0014, the workflow:
  - an OIDC role that trusts only `refs/heads/develop` and may push to ECR, deploy the testnet
    service stack and pass only the testnet roles;
  - it runs on a push to `develop` unless only `lore/**`, `docs/**` or Markdown changed, and by
    hand, in a `concurrency` group;
  - actions are pinned by commit SHA. `permissions: {}` is set at the top, and the deploy job
    gets only `id-token: write` and `contents: read`;
  - before the service update, it runs the one-off migration task from ADR 0012 (task 0013),
    and the deploy role may run it;
  - the last step waits for `ready: true` from `/health`.
- From 0014, secrets:
  - `FACILITATOR_SECRET` is a SecureString under `/x402/testnet/`, created by hand with
    `aws ssm put-parameter`;
  - it is encrypted with the testnet KMS key, whose policy gives `kms:Decrypt` only to the task
    execution role;
  - a keyed RPC URL and the database credentials go the same way.
- From 0013 ([ADR 0012](../../../docs/adr/0012-facilitator-state-store.md)), the database:
  - isolated private subnets for RDS, with no NAT;
  - a db.t4g.micro Single-AZ RDS for PostgreSQL 18 instance, its security group and its parameter
    group;
  - the database credentials as a SecureString under `/x402/testnet/db`;
  - migrations written expand/contract, because the old task keeps serving while they run;
  - a failover drill and the upgrade policy in the runbook.
- From 0014: `GET /health` answers 200 and reports `ready` in its body.
- From 0014, the runbook: deploy, rollback (redeploy an earlier SHA) and key rotation as an
  on-chain signer change.
- From 0014, prerequisites:
  - a `rumblefish.dev` subdomain (proposed `testnet.x402.rumblefish.dev`), as a record in the
    company zone or a delegated subzone, with Route 53 access;
  - the region (eu-central-1 assumed).

  There is no CloudFront fallback.
- Option from 0022's third review, to verify rather than a decision (a better approach may exist):
  - Separate database roles: a migrator that owns the schema, and an app role with DML only.
    `pnpm migrate` would then read its own URL variable.
  - Measure commit latency under a flood of rate-limit `hit` calls running alongside `claim`.
  - Migrations are tracked by name only. A checksum of each migration's SQL would catch an edited
    one. 0022's first review judged this too small; it matters once a database is durable.
  - The startup schema check (0025/0026) should accept a database ahead of the code, i.e. every
    known migration applied. Otherwise a rollback to an earlier SHA refuses to start.
- From 0022: measure `addHash` and the full settle path on the testnet database this task creates;
  0022 had no instance to measure on (ADR 0012's Consequences).
- From 0009 (PR #41, decision 47): decide where `RPC_URLS` lives on the server and keep its old
  values.
  - A keyed RPC URL is a secret (ADR 0011), but the Hetzner move left its store open: ADR 0013
    covers only the signing key.
  - Logs name an endpoint `RPC_URLS[i]#<fingerprint>` (the first 8 hex digits of the entry's
    SHA-256), and `RPC_URLS[i]` can mean another URL after a redeploy. Matching an old line to a
    URL needs that URL: a store with versions, or each change recorded in the deploy history. A
    plain env file that is edited in place loses it.

## Acceptance Criteria

- [ ] Given the platform chosen in the 0014 ADR, when a deploy runs, then a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL
- [ ] Given a running instance, when a new version is deployed, then the old process stops before the new one starts; the process is long-lived and never scaled to zero
- [ ] Given the facilitator key, when the service is deployed, then it comes from the platform's secret store, never from the image or the logs, and is a testnet-only key
- [ ] Given the durable stores from 0022, when the service runs, then it uses them, and `docs/runbook.md` has the deploy and rollback steps
