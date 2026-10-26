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

- [ ] Every facilitator test runs against PostgreSQL; no memory adapter is left
- [ ] `pnpm dev` and `pnpm test` work from the repo's compose file
- [ ] `STORE` is gone from the config, the env examples and the docs
- [ ] The suite's run time is measured before and after, and recorded here
- [ ] A leftover `STORE` in the environment is refused at boot (decision 3)

## Decisions so far

One row per atomic decision, settled before the code. Each row becomes a test before its code.

| #   | What is done | From | vs the task | Who does the same (checked) | Code · test |
| --- | ------------ | ---- | ----------- | --------------------------- | ----------- |
| 1   | A `compose.yaml` at the repo root runs PostgreSQL 18 on port 15432. Tests use `TEST_DATABASE_URL`, else that compose database; with no database reachable a test file fails with the cause and the command to run, and nothing is skipped | grilling | changes "`pnpm test` needs `TEST_DATABASE_URL`" | CI's `postgres:18` service | |
| 2   | `pnpm dev` applies the migrations to the local database, then starts the service; deployments keep migrating by hand (`pnpm migrate`) | grilling | beyond it | | |
| 3   | `STORE` is refused at boot, as `TRUSTED_PROXY_HOPS` is: a leftover line must not look like it still picks a store | grilling | beyond it | | |
| 4   | Two PRs: tests move to PostgreSQL first (no runtime change), then `STORE` and the memory adapters go | agent | matches | | |
| 5   | Each test file gets its own schema, emptied before each test that takes stores, as `postgres.test.ts` does; one helper holds that setup | agent | matches | | |
| 6   | The settler's unit tests also run on PostgreSQL; no fake store is kept in a test file | agent | matches AC 1 | | |
| 7   | Port 15432, not 5432: a developer's own PostgreSQL often holds 5432. Not 54320 either: it lies in the random port range (macOS 49152–65535, Linux 32768–60999), and a test server on port 0 got it and sent its requests to PostgreSQL | agent | beyond it | | |
