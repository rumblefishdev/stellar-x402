---
id: "0025"
title: "Channel lease and graceful shutdown"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0006", "0011"]
related_tasks: ["0012", "0009", "0019", "0022", "0014", "0039"]
tags: [facilitator, signer-pool, operations, priority-high, effort-small, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.4 (Payments lane)."
---

# Channel lease and graceful shutdown

## Summary

As a facilitator operator, I want only one process at a time to settle through a network's channel set, so that a deploy or a second instance never collides on channel sequence numbers.

**Story:** [M1 Story 2.4](../../../docs/planning/m1-epics.md#story-24-channel-lease-and-graceful-shutdown) · **Lane:** Payments · **Covers:** FR11 (AD-17); NFR9

## Context

- Deploys stop the old process before the new one starts (0014, 0026).
- Builds on the record lifecycle from 0019 so in-flight work is recorded before release.
- Related tasks: 0009, 0019, 0022.

## Implementation

- Lease acquire, renew and release through the store port (fake first, real adapter from 0022).
- Shutdown handler that drains the pool.
- Tests for a second process, a crash and a clean stop.
- From 0039 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md), revised for the Hetzner server): a deploy stops the old
  container first. Docker sends SIGTERM, then SIGKILL after `stop_grace_period` 180 s. There's no
  load-balancer deregistration, so on SIGTERM the process itself:
  - answers new `/settle` with 503 and lets open requests finish (90 s budget);
  - refuses every call not yet signed and sent: waiting for a channel, prepared ahead, or still
    reading a sequence. The pool can't cancel those today, so signer-pool needs a `close()` that
    rejects them;
  - waits until sent submissions are final or recorded as pending, then releases the lease.
- From 0014: `GET /health` never looks at the lease. `/settle` answers 503 at once until the
  process holds the lease and the 0019 startup reconciliation has finished. A process without the
  lease keeps trying to take it and never exits; one whose renewal fails stops new submissions
  until it holds the lease again. The lease, not the deploy order, keeps two processes apart.

## Acceptance Criteria

- [ ] Given a process starting, when it boots, then it takes an exclusive lease on its network's channel set through the store and keeps renewing it; without the lease it doesn't serve `/settle`
- [ ] Given a second process for the same channel set, when it starts, then it can't take the lease and submits nothing
- [ ] Given a shutdown signal, when the process stops, then it refuses new `/settle` calls, waits until every in-flight submission is final or recorded as pending, then releases the lease
- [ ] Given a process that dies without releasing, when the lease TTL passes, then a new process can take the lease
- [ ] Given a process without the lease or still reconciling, when `/settle` is called, then it answers 503 at once, and the process keeps trying to take the lease without exiting (ADR 0011)
- [ ] Given a shutdown signal with calls still waiting for a channel, when the process drains, then those calls are refused unsent and the drain finishes within the 180 s stop grace period (ADR 0011)
