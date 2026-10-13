---
id: "0039"
title: "Move facilitator hosting to the company Hetzner server in ADR 0011"
type: DOCS
status: active
milestone: 1
related_adr: ["0011", "0012"]
related_tasks: ["0014", "0009", "0013", "0023", "0025", "0026", "0027", "0036", "0038"]
tags: [facilitator, deploy, hosting, operations, priority-high, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-12"
    status: active
    who: stkrolikiewicz
    note: >
      The team moves hosting from ECS Fargate to the company Hetzner server (ch-prod-01) for
      testnet and mainnet. ADR 0011 is revised in place; the facilitator key moves into AWS KMS on
      both networks, and CloudWatch stays.
---

# Move facilitator hosting to the company Hetzner server in ADR 0011

## Summary

ADR 0011 (task 0014) put the facilitator on ECS Fargate. The team decided to run it on the
company's existing Hetzner server, which already hosts ClickHouse and has plenty of free
resources, for both networks. This task revises ADR 0011 in place and updates the tasks that
build on it.

## Context

- **The server, as read on 2026-10-12** (`ssh sorban-prod`):
  - host `ch-prod-01`, x86_64, 24 cores at a load of about 2;
  - 125 GiB RAM, of which about 120 GiB is available, and ClickHouse runs in a container
    limited to 108 GiB;
  - 1.8 TB on RAID, 731 GB free;
  - Docker Compose v5, with Caddy already terminating HTTPS in the same compose project as
    ClickHouse.
- **Decisions taken with Stan on 2026-10-12:**
  - edit ADR 0011 in place, not supersede it;
  - the facilitator key goes into AWS KMS on both networks;
  - CloudWatch stays, fed from the server;
  - deploys go through GitHub Actions over SSH with Docker Compose.

## Acceptance Criteria

- [x] ADR 0011 describes hosting on the Hetzner server: containers and limits, stop-before-start
      deploys, Caddy, the key in KMS, Postgres on the server with off-server backups, CloudWatch
      from the server, and the consequences of a shared single server
- [x] The tasks that build on ADR 0011 (0009, 0013, 0023, 0025, 0026, 0027, 0036, 0038), the
      spine and `deploy/README.md` match the revised ADR
