---
id: "0038"
title: "Decide the mainnet availability setup on the Hetzner server"
type: RESEARCH
status: backlog
related_adr: ["0011"]
related_tasks: ["0014", "0025", "0026", "0027", "0039"]
tags: [facilitator, mainnet, availability, deploy, priority-low, effort-medium, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-12"
    status: backlog
    who: claude
    note: "Spawned from 0014 future work: ADR 0011 leaves the two-task option and the WAF rule to the mainnet launch."
  - date: "2026-10-13"
    status: backlog
    who: stkrolikiewicz
    note: "Reframed for the Hetzner server (0039): two containers on one server, a second machine or standby, edge rate limiting."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "PR #24 round three: one OpenBao per server is settled (ADR 0013); the Hetzner Cloud VM and the digest check in the mainnet deploy.sh are mainnet questions here."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "Cloudflare Tunnel replaces the shared Caddy (0039): the mainnet tunnel, edge rate limiting on Cloudflare and its Free plan's missing SLA are mainnet questions here."
  - date: "2026-10-23"
    status: backlog
    who: stkrolikiewicz
    note: "The Hetzner Cloud VM is rejected for mainnet too (ADR 0011, Alternatives); it is no longer a question here."
---

# Decide the mainnet availability setup on the Hetzner server

## Summary

ADR 0011 (revised in 0039) runs one facilitator container per network on one physical server,
shared with ClickHouse. A deploy or a crash is a short outage, and a hardware fault takes the
service down until the server is repaired or the service is restored elsewhere. Before the mainnet
launch, this task decides how much of that to remove.

## Context

- **Two facilitator containers with separate channel sets on the same server:**
  - each container takes a free channel set's lease, and a deploy replaces them one at a time;
  - that removes deploy downtime and covers a crash of one container, but not a hardware fault;
  - it changes AD-17's one channel set per network and extends the 0025 lease to channel sets;
  - it costs a second channel set (1.5 XLM reserve per channel) and no extra hardware.
- **A second machine or a standby** for hardware faults. Options:
  - a warm standby restored from the off-server backups;
  - a second server running the second channel set.
- **Edge rate limiting:** the in-app limits (AD-11, AD-18) only act once a request has reached
  the server. Cloudflare can stop a flood earlier, but the Free plan has one rate-limit rule for
  the whole `sorobanscan.com` zone, shared with sorobanscan and the Prices API.
- **Cloudflare's plan:** the Free plan has no uptime SLA. Business (about $200 a month, for the
  whole zone) has one. Decide whether mainnet needs it, weighed against the one server, which
  is the larger risk.
- **The ECS Fargate variant** in the first version of ADR 0011 remains the managed alternative.
- **From 0039 (PR #24 review), to settle before mainnet:**
  - a ruleset that protects `v*` tags, since the workflow at the tag runs with the mainnet key;
  - a mainnet `deploy.sh` that itself refuses a digest without a successful `testnet`
    deployment (the workflow checks it today, ADR 0011);
  - named reviewers for mainnet deploys, and who may edit the environments;
  - whether admins may bypass the `mainnet` environment's reviewers (ADR 0011). GitHub lets them
    by default, so until then they can;
  - a deploy user per network;
  - the mainnet tunnel (`x402-facilitator.sorobanscan.com`) in `soroban-infrastructure`;
- Related tasks: 0014, 0025, 0026, 0027, 0039.

## Implementation

- Set concrete targets for this decision: the longest downtime and the most data lost after a
  hardware fault that mainnet accepts. One machine is fine for testnet, and its backups lose
  about a minute (ADR 0011).
- Weigh the mainnet uptime target (99%, `docs/monitoring.md`) against the measured downtime of a
  testnet deploy, a crash and a restore drill.
- If two containers are chosen:
  - change AD-17 in the spine;
  - extend the 0025 lease to channel sets;
  - run a deploy on testnet with two containers while payments flow.
- Decide the hardware-fault plan and edge rate limiting.

## Acceptance Criteria

- [ ] Given the mainnet uptime target and the testnet measurements, when the decision is made,
      then ADR 0011 (or a new ADR) records the mainnet setup for deploys, hardware faults and
      edge rate limiting, and why
- [ ] Given two containers are chosen, when a new version is deployed on testnet with payments
      flowing, then no `/settle` fails for lack of a serving process, and each process settles
      only through its own channel set
