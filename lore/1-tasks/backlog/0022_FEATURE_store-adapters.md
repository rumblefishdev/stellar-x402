---
id: "0022"
title: "Durable adapters for the four store ports"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0004", "0006"]
related_tasks: ["0012", "0013", "0017"]
tags: [facilitator, persistence, priority-high, effort-medium, discovery]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.1 (Discovery lane)."
---

# Durable adapters for the four store ports

## Summary

As a facilitator operator, I want durable implementations of the four store ports, so that settlements, catalog entries, rate limits and budgets survive restarts and deploys.

**Story:** [M1 Story 2.1](../../../docs/planning/m1-epics.md#story-21-durable-adapters-for-the-four-store-ports) · **Lane:** Discovery · **Covers:** FR10, FR11, FR13, FR15 (AD-7)

## Context

- Every lane builds against in-memory fakes until this lands; target is day 9, before the public deploy and the lease need it.
- The operations each port needs are listed in 0013 and AD-7.
- Related tasks: 0013, 0017.

## Implementation

- Shared contract-test suite per port, run against both the fake and the real adapter.
- Adapters and migrations for the store chosen in 0013.
- Config switch in the composition root.

## Acceptance Criteria

- [ ] Given the store chosen in the 0013 ADR, when the adapters are built, then `SettlementStore`, `CatalogStore`, `RateLimitStore` and `SpendStore` each have an adapter in `apps/facilitator/src/adapters/` that passes the same contract tests as its in-memory fake
- [ ] Given concurrent claims for one settlement key, when they hit the store, then exactly one wins; lookup by any hash, forward-only compare-and-set, the exclusive renewable channel lease, catalog upserts by key and the `resources` filters are all supported
- [ ] Given a fresh environment, when migrations run, then the schema is created with one command; the composition root picks the memory or the real stores from config
