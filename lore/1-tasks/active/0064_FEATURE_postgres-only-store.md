---
id: "0064"
title: "Run tests, local runs and deploys on PostgreSQL only, and drop the memory store"
type: FEATURE
status: active
milestone: 1
related_adr: ["0012"]
related_tasks: ["0022", "0023", "0050"]
tags: [facilitator, persistence, testing, priority-medium, effort-medium]
links:
  - ../../../docs/adr/0012-facilitator-state-store.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0023's review: STORE=memory|postgres runs two implementations of one store."
  - date: "2026-10-26"
    status: active
    who: karolkow
    note: "Work starts."
---

# Run tests, local runs and deploys on PostgreSQL only, and drop the memory store

## Summary

`STORE=memory|postgres` keeps two implementations of every store port. What passes on the memory
store can fail on PostgreSQL: a NUL in a `/settle` body passed the memory store and was a 500 on
PostgreSQL, found only in 0009's review (0023 now refuses it as a 400). Run everything on
PostgreSQL and delete the memory adapters, so the code under test is the code that runs.

## Context

- The shared contract suite `test/port-contracts.ts` runs against both adapters
  (`memory.test.ts`, `postgres.test.ts`); it is today's only guard against drift.
- `src/adapters/memory.ts` is 264 lines; 10 test files use it after 0050 and 0032 merged
  (measured 2026-10-26).
- Measured 2026-10-23 (local PostgreSQL 14): the whole suite on the memory store takes 5.9 s; the
  71 PostgreSQL contract tests take 3.1 s, each test on its own schema.
- CI already runs PostgreSQL (`TEST_DATABASE_URL`).
- The spine (in-memory fakes for tests) and ADR 0012 (`STORE=memory|postgres`) record the memory
  store, so both are amended. 0022 and 0050 own the PostgreSQL store: agree the change with their
  owner first.

## Implementation

- Tests take a fresh schema per file, as `postgres.test.ts` does; `pnpm test` reaches the repo's
  compose PostgreSQL unless `TEST_DATABASE_URL` is set, and fails loudly without a database
  (decision 1).
- A `docker compose` file with PostgreSQL for `pnpm dev` and `pnpm test`.
- Remove `STORE`, `memoryStores()`, `src/adapters/memory.ts` and `memory.test.ts`; `DATABASE_URL`
  becomes required.
- Amend ADR 0012 and the spine.

## Acceptance Criteria

- [x] Every facilitator test runs against PostgreSQL; no memory adapter is left
- [x] `pnpm dev` and `pnpm test` work from the repo's compose file
- [x] `STORE` is gone from the config, the env examples and the docs
- [x] The suite's run time is measured before and after, and recorded here
- [x] A leftover `STORE` in the environment is refused at boot (decision 3)

## Measurements

- Facilitator suite, PostgreSQL 18 in Docker (measured 2026-10-26): before, 462 tests in about
  5.8 s, 72 of them skipped without `TEST_DATABASE_URL`; with the tests on PostgreSQL, 480 tests
  (develop moved) in 6.0 to 6.2 s over 5 runs; without the memory adapter's own suite, 427 tests.
- `pnpm dev` on an empty database applied `0001` to `0004`, then reached the channel check.
- Timing tests under load: with a load average near 50, develop failed a timing test in 1 of 8 runs
  and the PostgreSQL suite in 6 of 8; near 25, 1 of 12. CI passed on Node 22 and 24. The settler's
  tests bound each store call to 200 ms (was 20) and give three budget cases 200 ms.

## Decisions so far

One row per atomic decision, settled before the code. Each row becomes a test before its code.

| #   | What is done | From | vs the task | Who does the same (checked) | Code · test |
| --- | ------------ | ---- | ----------- | --------------------------- | ----------- |
| 1   | A `compose.yaml` at the repo root runs PostgreSQL 18 on port 54320. Tests use `TEST_DATABASE_URL`, else that compose database; with no database reachable a test file fails with the cause and the command to run, and nothing is skipped | grilling | changes "`pnpm test` needs `TEST_DATABASE_URL`" | CI's `postgres:18` service | `compose.yaml`, `test/database.ts` · `database.test.ts` |
| 2   | `pnpm dev` applies the migrations to the local database, then starts the service; deployments keep migrating by hand (`pnpm migrate`) | grilling | beyond it | | `package.json` `dev` · run by hand (Measurements) |
| 3   | `STORE` is refused at boot, as `TRUSTED_PROXY_HOPS` is: a leftover line must not look like it still picks a store | grilling | beyond it | | `config.ts` · `config.test.ts` "refuses a leftover STORE" |
| 4   | Two PRs: tests move to PostgreSQL first (no runtime change), then `STORE` and the memory adapters go | agent | matches | | PR #65, then the drop PR |
| 5   | Each test file gets its own schema, emptied before each test that takes stores, as `postgres.test.ts` does; one helper holds that setup | agent | matches | | `test/database.ts` · every store test file |
| 6   | The settler's unit tests also run on PostgreSQL; no fake store is kept in a test file | agent | matches AC 1 | | `settle.test.ts` · its suite |
| 7   | Port 54320, not 5432: a developer's own PostgreSQL often holds 5432 | agent | beyond it | | `compose.yaml` · `database.test.ts` |
