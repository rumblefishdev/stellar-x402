---
id: "0022"
title: "Durable adapters for the four store ports"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004", "0006"]
related_tasks: ["0012", "0013", "0017", "0009", "0023"]
tags: [facilitator, persistence, priority-high, effort-medium, discovery]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.1 (Discovery lane)."
  - date: "2026-10-12"
    status: active
    who: akot
    note: "Started by the Discovery lane on the 0013 decision (ADR 0012, PR #20): PostgreSQL adapters from the spike."
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
- From 0017: the suites are `apps/facilitator/test/port-contracts.ts`; `test/memory.test.ts`
  shows how to run them against an adapter. They include concurrent claims and transitions,
  so the durable compare-and-set must be atomic.
- From 0017: a bigint codec for stored amounts (`feeCharged`, spend reservations and limits).
- From 0017: `CatalogStore.list` is in insertion order and an upsert keeps an entry's place, so
  the durable catalog needs a serial or `created_at` order.
- From 0009 (PR #41 reviews): the `SettlementStore` port grew, and its contract tests fail an
  adapter written from 0013's ADR alone:
  - `markSuccessAnswered(key, at)`: a compare-and-set on `successAnsweredAt` while the record is
    `success`; it leaves `updatedAt` as it is;
  - `addHash` is atomic with `transition`: against a concurrent `claimed → rejected`, exactly one
    wins;
  - every call needs its own timeout: `/settle` bounds them by its budget and a 1 s grace, but a
    hung driver call still holds a connection.
- From 0009: what a durable, shared store adds, which the memory store can't show:
  - **clock skew** between instances on `unsignedUntil = existing.createdAt + SETTLE_BUDGET_MS`,
    which compares one instance's `createdAt` with another's clock;
  - **the `addHash` / budget race** (0009 decision 35): `onSigned` checks the budget flag again
    after `addHash`; keep that order, and test a slow `addHash`;
  - **two settlers on one store** for the repeat paths (0009 decisions 29, 31): a repeat that
    can't end a record answers `settlement_pending`, and a success the store can't mark is
    answered once per process only.
- From 0009 (with 0023): `MemorySettlementStore` keeps every claimed record, with its full
  payload (up to 64 KB of `extra`/`extensions`). Self-payments that end `no_channel_in_time`
  cost an attacker nothing on chain and add about 16k records per GB, so a public testnet
  facilitator on `STORE=memory` grows until it restarts. Lift `main()`'s pubnet refusal only
  with a durable store (0009 decision 18).
- From 0031: `CatalogStore.upsert` is conditional on `ledger` (an earlier one only adds missing
  requirements) and stores `keyVersion`, which the port can't read back, so the adapter's own
  test checks that column.

## Acceptance Criteria

- [ ] Given the store chosen in the 0013 ADR, when the adapters are built, then `SettlementStore`, `CatalogStore`, `RateLimitStore` and `SpendStore` each have an adapter in `apps/facilitator/src/adapters/` that passes the same contract tests as its in-memory fake
- [ ] Given concurrent claims for one settlement key, when they hit the store, then exactly one wins; lookup by any hash, forward-only compare-and-set, the exclusive renewable channel lease, catalog upserts by key and the `resources` filters are all supported
- [ ] Given a fresh environment, when migrations run, then the schema is created with one command; the composition root picks the memory or the real stores from config
