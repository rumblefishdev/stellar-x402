---
id: "0039"
title: "Move facilitator hosting to the company Hetzner server in ADR 0011"
type: DOCS
status: active
milestone: 1
related_adr: ["0011", "0012", "0013"]
related_tasks: ["0014", "0009", "0013", "0019", "0023", "0025", "0026", "0027", "0036", "0038", "0047"]
tags: [facilitator, deploy, hosting, operations, priority-high, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-12"
    status: active
    who: stkrolikiewicz
    note: >
      The team moves hosting from ECS Fargate to the company Hetzner server for
      testnet and mainnet. ADR 0011 is revised in place; the facilitator key moves into AWS KMS on
      both networks, and CloudWatch stays.
  - date: "2026-10-20"
    status: active
    who: stkrolikiewicz
    note: >
      The facilitator key lives in OpenBao Transit on the server (ADR 0013, task 0047) instead of
      AWS KMS; AWS stays for logs and metrics only.
  - date: "2026-10-21"
    status: active
    who: stkrolikiewicz
    note: >
      Second review round on PR #24: a directory and a systemd unit per network own deploys, a
      failed deploy rolls back, reboots wait for the drain, backups leave from the host, the
      alarms follow ADR 0013, and testnet deploys from a protected deploy/testnet branch.
---

# Move facilitator hosting to the company Hetzner server in ADR 0011

## Summary

ADR 0011 (task 0014) put the facilitator on ECS Fargate. The team decided to run it on the
company's existing Hetzner server, which already hosts ClickHouse and has plenty of free
resources, for both networks. This task revises ADR 0011 in place and updates the tasks that
build on it.

## Context

- **The server, as checked on 2026-10-12** (the specifics are kept out of this public repo):
  - x86_64, with plenty of free CPU, RAM and disk, and ClickHouse held to a memory limit in its
    container;
  - Docker Compose, with Caddy already terminating HTTPS in the same compose project as
    ClickHouse.
- **Decisions taken with Stan on 2026-10-12:**
  - edit ADR 0011 in place, not supersede it;
  - the facilitator key goes into AWS KMS on both networks. Changed on 2026-10-20: it lives in
    OpenBao Transit on the server (ADR 0013, task 0047), and AWS stays for logs and metrics;
  - CloudWatch stays, fed from the server;
  - deploys go through GitHub Actions over SSH with Docker Compose.

## Acceptance Criteria

- [x] ADR 0011 describes hosting on the Hetzner server: containers and limits, stop-before-start
      deploys, Caddy, the key in OpenBao (ADR 0013), Postgres on the server with off-server
      backups, CloudWatch from the server, and the consequences of a shared single server
- [x] The tasks that build on ADR 0011 (0009, 0013, 0019, 0023, 0025, 0026, 0027, 0038), the
      spine and `deploy/README.md` match the revised ADR; 0036 is reshaped by 0047 (ADR 0013)
