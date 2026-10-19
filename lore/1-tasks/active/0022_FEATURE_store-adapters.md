---
id: "0022"
title: "Durable adapters for the four store ports"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004", "0006", "0012"]
related_tasks: ["0012", "0013", "0017", "0042"]
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
  - date: "2026-10-13"
    status: active
    who: akot
    note: >
      Built and reviewed: four PostgreSQL adapters, pnpm migrate, STORE=postgres, a CI service.
      All 4 acceptance criteria met; 108 facilitator tests (43 on PostgreSQL). Final review fixes
      are in. Spawned 0042 (pruning). Closes after PR merge.
  - date: "2026-10-19"
    status: active
    who: akot
    note: >
      Merged develop (through the updated 0013 base). Review fix: a connection whose Read Committed
      SET fails is now closed (decision 6). 164 facilitator tests (44 on PostgreSQL). Closes after
      PR merge.
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

- [x] Given the store chosen in the 0013 ADR, when the adapters are built, then `SettlementStore`, `CatalogStore`, `RateLimitStore` and `SpendStore` each have an adapter in `apps/facilitator/src/adapters/` that passes the same contract tests as its in-memory fake
- [x] Given concurrent claims for one settlement key, when they hit the store, then exactly one wins; lookup by any hash, forward-only compare-and-set, the exclusive renewable channel lease, catalog upserts by key and the `resources` filters are all supported
- [x] Given a fresh environment, when migrations run, then the schema is created with one command; the composition root picks the memory or the real stores from config
- [x] Given CI, when it runs, then the four contract suites run against the PostgreSQL adapters on a service container, fail if the database is unreachable (no skip), and use a test pool larger than the 10-way concurrency cases

## Result

- `adapters/postgres.ts` holds the four adapters on one `pg` pool. `adapters/postgres-schema.ts`
  holds the schema as ordered SQL migrations. `adapters/rules.ts` holds the lifecycle and catalog
  merge rules that both adapters share.
- `pnpm migrate` (`src/migrate.ts`) applies the migrations under a transaction-level advisory lock.
  The service never migrates itself.
- `STORE=postgres` with `DATABASE_URL` selects the PostgreSQL stores. `STORE=memory` is testnet
  only.
- CI runs the suites on a `postgres:18` service on Node 22 and 24. `TEST_DATABASE_URL` is in
  turbo's `test.env`.
- Tests: the contract suites gained cases for hash conflicts, older rate-limit windows, scope order,
  contested leases, past-the-end listing, int64 amounts, out-of-order `now` and a retried rejected
  reservation. Memory runs 34 cases and PostgreSQL 44, which add the migration, lock-wait,
  dropped-connection, isolation and failed-`SET` cases. The facilitator has 164 tests in all,
  after merging develop. Before the PR, a final review by two independent reviewers was
  reconciled into one list.

## Design Decisions

### From Plan

1. **`addHash` rejects a hash another settlement already has** with a typed `HashConflictError`,
   and neither record changes. Both adapters do this; the team chose it during 0022.
2. **A rate-limit hit from an older window counts in the newer one.** `GREATEST` keeps the newer
   `reset_at`, with qualified columns.
3. **Our own migration runner, not a library:** a `schema_migrations` table, one Read Committed
   transaction, `pg_advisory_xact_lock` and a 10 s `lock_timeout`. There is one migration today,
   and ADR 0012 asks for a transaction-level lock. The migrations are TS strings, so `tsc` ships
   them.
4. **The suites skip locally only when neither `TEST_DATABASE_URL` nor `CI` is set,** so CI never
   skips them. Each run gets its own schema.
5. **Pruning is out of 0022** (the team decided). It is spawned as 0042.

### Emerged

6. **Every connection sets Read Committed as its session default,** in the pool's `onConnect`. Until
   then only the transactions set it, so single statements took the server's default; under
   Repeatable Read the concurrent claims threw serialization errors. A config `options` setting
   would be overridden by an `options` parameter in the URL. The pool waits for `onConnect`, so a
   connection whose `SET` fails is closed and its caller's query fails; a `connect` listener could
   only log the failure and hand the connection out at the server's default.
7. **Every pool client keeps an `error` listener.** pg-pool removes its own listener while a client
   is checked out, so a connection lost mid-transaction (a failover, a reboot, the idle-in-transaction
   timeout) crashed the process. Now the transaction fails.
8. **The spend window has no upper bound (`at > now - windowMs`).** The SPEC kept this G-note gap
   out. The final review showed it overspends on a single instance too, because the caller takes
   `now` before `reserve` waits on the scope lock. The team pulled it in. The port docs now say
   that a later stamp counts.
9. **`STORE=memory` is testnet only, and `DATABASE_URL` with it is an error** (team decision in
   the final review). A pubnet deploy that forgets `STORE` would otherwise lose settlements on
   restart.
10. **`migrate` keeps the pool's statement limit.** An earlier review added
    `SET LOCAL statement_timeout = 0`. That did nothing useful: the client's 15 s `query_timeout`
    still gave up while the server kept running. A pool just for migrations waits for a migration
    that needs one.
11. **Lock-wait reads have deterministic tests.** These hold a transaction open on a second
    connection: `addHash` re-reading the hash owner, and `transition` reading hashes after its row
    lock. The racy contract case reached the first only about half the time.

## Issues Encountered

- **The concurrent-claim case failed once and was never reproduced.** It failed in one of 13
  turbo runs. Since then it passed:
  - 40 direct runs, 15 `turbo --force` runs and 48 runs six at a time under CPU load;
  - 1,300 isolated claim races.

  The claim path is correct at Read Committed. The case is the only one that grows the pool from 1
  to 10 connections, and the local cluster restarted many times that day. That points to the
  environment, and turbo's cache made the 1-in-13 figure soft as well.
- **Turbo's strict env mode dropped `TEST_DATABASE_URL`.** `passThroughEnv` also left it out of the
  cache hash, so a cached run replayed 36 skipped cases. Moved to `env`.
- **Modified tests:** `config.test.ts` now uses `STORE=postgres` with a URL wherever it uses
  pubnet (the mapping case, the CATALOG_ALLOW_HTTP case, the RPC_URLS case). This follows from
  decision 9 and is not a regression. The spend case "counts only the rolling window ending at
  now" is renamed, because the window no longer ends at `now`. The pubnet https case that develop
  added to "checks RPC URLs" uses the same pubnet helper after the merge.

## Future Work

- 0042: prune old rate-limit windows and spend reservations, and index the spend-window sum.
- For 0025/0026: check at startup that the database is reachable and its schema is current, and
  test `main()` with `STORE=postgres`.
- For 0026: the RDS CA bundle and TLS, and `STORE`, `DATABASE_URL` and `pnpm migrate` in the deploy
  env examples.
- For 0009 and the routes: map `HashConflictError`; validate `\u0000` in payloads and resources, and
  negative `limit`/`offset`.
- With migration `0002`: a test that a failing migration rolls back.
