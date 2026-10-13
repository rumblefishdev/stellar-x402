---
id: "0026"
title: "Public testnet deployment"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0012", "0014", "0022", "0017", "0020", "0036", "0039"]
tags: [facilitator, deploy, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.5 (Platform lane)."
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
- From 0039 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md), revised): Docker Compose on the company Hetzner server
  (`ch-prod-01`, x86_64), project `x402`, owned by its own Linux user, apart from ClickHouse's
  `app` project.
  - `facilitator-testnet`: memory limit 512 MiB, one CPU, `restart: unless-stopped`,
    `stop_grace_period` 180 s, healthcheck on `/health` every 10 s, no published port.
  - `postgres-testnet`: PostgreSQL 18, memory limit 1 GiB, data on a volume, reachable only from
    the facilitator.
  - Node `keepAliveTimeout` 125 s, with `headersTimeout` above it; `TRUSTED_PROXY_HOPS=1`.
- From 0039, the image: `pnpm deploy --prod` with `injectWorkspacePackages: true`;
  `"files": ["dist"]` in `apps/facilitator/package.json` and a `.dockerignore` that excludes
  `.env*`; `node:22-slim` pinned by digest, `linux/amd64`, user `node`, read-only root filesystem.
  Images go to GHCR, tagged with the git SHA; the workflow skips the build when the SHA exists.
- From 0039, the deploy:
  - GitHub Actions connects over SSH as a deploy user whose key runs one forced command, a deploy
    script in `deploy/`;
  - the script pulls the image and runs the migration task (ADR 0012), then stops the old
    container, starts the new one and waits for `ready: true` from `/health`;
  - it runs on a push to `develop` unless only `lore/**`, `docs/**` or Markdown changed, and by
    hand, in a `concurrency` group;
  - actions are pinned by commit SHA, with minimal token permissions, and the SSH key is an
    environment secret.
- From 0039, keys and secrets:
  - the facilitator signs through the testnet AWS KMS key (0036, a prerequisite);
  - the server gets short-lived AWS credentials through IAM Roles Anywhere;
  - the database password and any keyed RPC URL are files of mode 0600, mounted as Compose
    secrets.
- From 0039: backups of `postgres-testnet` go off the server (a daily base backup and a WAL
  archive), with a restore drill.
- From 0039: the Caddy site block for the subdomain is agreed with the owner of the ClickHouse
  project, and an A record in Route 53 points at the server.
- From 0039: `GET /health` answers 200 and reports `ready` in its body.
- From 0039, the runbook: deploy, rollback (redeploy an earlier digest), key rotation as an
  on-chain signer change, and restoring the service on another machine.

## Acceptance Criteria

- [ ] Given the platform chosen in the 0014 ADR, when a deploy runs, then a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL
- [ ] Given a running instance, when a new version is deployed, then the old process stops before the new one starts; the process is long-lived and never scaled to zero
- [ ] Given the facilitator key, when the service is deployed, then it signs through the testnet KMS key, and the key never reaches the server, the image or the logs (ADR 0011)
- [ ] Given the durable stores from 0022, when the service runs, then it uses them, and `docs/runbook.md` has the deploy and rollback steps
