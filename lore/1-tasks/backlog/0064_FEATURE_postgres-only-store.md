---
id: "0064"
title: "Run tests, local runs and deploys on PostgreSQL only, and drop the memory store"
type: FEATURE
status: backlog
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
- `src/adapters/memory.ts` is 264 lines; 7 test files use `memoryStores()`.
- Measured 2026-10-23 (local PostgreSQL 14): the whole suite on the memory store takes 5.9 s; the
  71 PostgreSQL contract tests take 3.1 s, each test on its own schema.
- CI already runs PostgreSQL (`TEST_DATABASE_URL`).
- The spine (in-memory fakes for tests) and ADR 0012 (`STORE=memory|postgres`) record the memory
  store, so both are amended. 0022 and 0050 own the PostgreSQL store: agree the change with their
  owner first.

## Implementation

- Tests take a fresh schema per file or test, as `postgres.test.ts` does; `pnpm test` needs
  `TEST_DATABASE_URL`, and fails loudly without it.
- A `docker compose` file with PostgreSQL for `pnpm dev` and `pnpm test`.
- Remove `STORE`, `memoryStores()`, `src/adapters/memory.ts` and `memory.test.ts`; `DATABASE_URL`
  becomes required.
- Amend ADR 0012 and the spine.

## Acceptance Criteria

- [ ] Every facilitator test runs against PostgreSQL; no memory adapter is left
- [ ] `pnpm dev` and `pnpm test` work from the repo's compose file
- [ ] `STORE` is gone from the config, the env examples and the docs
- [ ] The suite's run time is measured before and after, and recorded here
