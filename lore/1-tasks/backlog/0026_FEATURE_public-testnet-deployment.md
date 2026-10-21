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
  - date: "2026-10-19"
    status: backlog
    who: okarcz
    note: "0047 (ADR 0013): the facilitator key moves to OpenBao Transit on the Hetzner server; adds its deployment and runbook."
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "Added where RPC_URLS lives and keeps its old values, from Stan's PR #41 review."
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "0047 (ADR 0013 amended): the unseal backup secret in AWS, the restore drill, the fee float and manual top-ups."
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

### The facilitator key in OpenBao (0047)

> [ADR 0013](../../../docs/adr/0013-facilitator-key-custody.md) replaces the SSM parameter for
> `FACILITATOR_SECRET` above. The facilitator moved to the company's Hetzner server; the rest of
> this task still follows ADR 0011 until a hosting ADR replaces it.

- **Containers:** OpenBao (the official image, pinned by digest) and the facilitator under Docker
  Compose, started by a systemd unit that passes in the credentials. Neither gets the Docker
  socket. Swap and core dumps off for OpenBao.
- **Link:** a unix socket in a volume shared only by the two containers; no TCP listener.
- **Keys:** one Transit key per network, generated inside OpenBao, `type=ed25519`,
  `exportable=false`, `allow_plaintext_backup=false`. One policy per network allowing only
  `transit/sign/<key>`, and one AppRole per network: `token_ttl` 1 h, `token_max_ttl` 24 h, a secret
  ID that doesn't expire, delivered as a Compose secret.
- **Unseal:** a static seal key as an encrypted systemd credential (`systemd-creds`, `host` mode).
  Note in the runbook whether the board has a TPM (ADR 0013's first upgrade).
- **Init:** `bao operator init -recovery-shares=1 -recovery-threshold=1`. Check that the static
  seal accepts these flags (the init docs name only HSM, KMS and Transit seals).
- **Backup secret** (ADR 0013): `x402/production/openbao-backup` in AWS Secrets Manager,
  `eu-central-1`, in the AWS account soroban-explorer and prices-api share; tags
  `Project=stellar-x402`, `Environment=production`; 30-day recovery window; default
  `aws/secretsmanager` key.
  - One JSON: `seal_key_hex`, `seal_key_id`, `seal_key_sha256`, `previous_seal_key_hex`,
    `previous_seal_key_id`, `recovery_key`, `borg_passphrase`, `borg_key_export`, `seal_config`,
    `openbao_version`, `updated`.
  - Made by hand from an admin's machine, never by CDK: stage the JSON in `/dev/shm`,
    `aws secretsmanager create-secret`, `shred`. Every change (a seal key rotation, a new Borg
    passphrase, an OpenBao upgrade) is a `put-secret-value` of the whole JSON; the old version stays
    as `AWSPREVIOUS`.
  - The server gets no AWS credentials. The runbook names the secret and its fields, never values.
- **Admin:** the root token revoked after setup, regenerated with the recovery key when needed;
  admin through SSH with the `bao` CLI; no UI.
- **Audit log:** a file on its own volume, rotated; alarm at 80% disk (0027).
- **Snapshots:** daily Raft snapshots to our own sub-account and Borg repository on the company's
  existing Hetzner Storage Box, keeping 14, set up like that box's other sub-account. Tell
  the team that owns the box that we depend on it. Decide the Borg mode (repokey or keyfile); in
  keyfile mode `borg key export` goes into the backup secret.
- **Fee float** (ADR 0013): refill to 100 XLM, alarm at 25 XLM, no upper limit, the same numbers on
  testnet for now. Set `checkFacilitatorBalance`'s `minSpendableStroops` to 25 XLM (its default is
  100 XLM).
- **Move testnet to the OpenBao key:** stop the service; with the current key, a `set_options` on
  the fee account and each channel adds the OpenBao key and removes the current one; start the
  service in `openbao` signer mode (0036).
- **Runbook** in `docs/runbook.md`:
  - **restore drill:** on a throwaway machine with no route to production, using only the backup
    secret and the Storage Box: pull the newest snapshot, start OpenBao with the seal key and key
    ID, init, restore (first without `-force`, then with it), regenerate a root token with the
    recovery key, issue an AppRole login, check that the Transit public key equals the on-chain
    signer, check the CloudTrail event history for reads that weren't drills, destroy the machine,
    log the result. First on testnet, before mainnet; then quarterly and after any seal key
    rotation, passphrase change or OpenBao upgrade;
  - **top-ups:** testnet with a one-line Friendbot script; mainnet by a withdrawal from the
    company's exchange account to the fee account (no memo). **Who makes it, and a backup person:
    TBD before mainnet;**
  - **weekly review** after the mainnet deploy (okarcz): the real fee spend, the next refill
    amount, and whether ADR 0013's custody still fits the float;
  - a leaked token or secret ID: destroy the secret ID, revoke its tokens, issue a new one;
  - a suspected key theft: new Transit key, move every account to it with the old key, drain the
    rest, check the fee-bump alarm's history;
  - OpenBao upgrades and what `/settle` does meanwhile (it answers an error).

## Acceptance Criteria

- [ ] Given the platform chosen in the 0014 ADR, when a deploy runs, then a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL
- [ ] Given a running instance, when a new version is deployed, then the old process stops before the new one starts; the process is long-lived and never scaled to zero
- [ ] Given the facilitator key, when the service is deployed, then it comes from the platform's secret store, never from the image or the logs, and is a testnet-only key
- [ ] Given the durable stores from 0022, when the service runs, then it uses them, and `docs/runbook.md` has the deploy and rollback steps
- [ ] Given the deployed facilitator, when it settles, then it signs through OpenBao Transit over the unix socket, no secret seed is on the server outside OpenBao, the backup secret exists in AWS, and a restore drill from it has passed
