---
id: "0022"
title: "Durable adapters for the four store ports"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004", "0006", "0012"]
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
- From 0031: `CatalogStore.upsert` is conditional on `ledger` (an earlier one only adds missing
  requirements) and stores `keyVersion`, which the port can't read back, so the adapter's own
  test checks that column.
- From 0013 ([ADR 0012](../../../docs/adr/0012-facilitator-state-store.md)): one PostgreSQL
  database, `pg` driver, Read Committed, app `now` only. A local spike passed the 0031 contract
  suites (23 cases) unchanged. The schema, statements and known gaps are in
  [G-postgres-port-mapping](../active/0013_RESEARCH_facilitator-state-store/notes/G-postgres-port-mapping.md).
  Watch for:
  - `addHash` is one statement, plus a re-read when the hash already exists. Hashes live in their
    own table, keyed by hash.
  - `transition` reads hashes in a second statement, because a subquery can return stale ones
    after a lock wait.
  - `list` takes `total` from a separate count, because `count(*) OVER()` returns no rows past
    the end.
  - `reserve` inserts and locks its scope rows in sorted order. At Repeatable Read it can
    overspend. It takes about seven round trips and holds the global scope's lock.
  - The rate-limit window uses `GREATEST`, so a hit from an older window doesn't reset the count.
  - Convert int8 per column (`BigInt` for stroops, `Number` for times), not with a global parser.
  - Migrations are plain SQL behind one command, under a transaction-level advisory lock. They are
    expand/contract, because the old ECS task serves while they run.
  - The `pg` client needs timeouts, keepalive, eviction of broken connections and
    `idle_in_transaction_session_timeout`. Prune old windows and reservations.
  - Measure `addHash` and the full settle path on the testnet instance. Locally, with a full
    flush, `addHash` was about 4 ms p50 and 5 ms p99.
- From 0013: new contract cases.
  - `addHash` with a hash another settlement already has: reject, and align the memory adapter.
  - A rate-limit hit from an older window.
  - `reserve` with scopes in reversed order.
  - A concurrent lease acquire.
  - `list` past the end of a non-empty catalog.
  - The int64-max round trip.

## Acceptance Criteria

- [ ] Given the store chosen in the 0013 ADR, when the adapters are built, then `SettlementStore`, `CatalogStore`, `RateLimitStore` and `SpendStore` each have an adapter in `apps/facilitator/src/adapters/` that passes the same contract tests as its in-memory fake
- [ ] Given concurrent claims for one settlement key, when they hit the store, then exactly one wins; lookup by any hash, forward-only compare-and-set, the exclusive renewable channel lease, catalog upserts by key and the `resources` filters are all supported
- [ ] Given a fresh environment, when migrations run, then the schema is created with one command; the composition root picks the memory or the real stores from config
- [ ] Given CI, when it runs, then the four contract suites run against the PostgreSQL adapters on a service container, fail if the database is unreachable (no skip), and use a test pool larger than the 10-way concurrency cases
