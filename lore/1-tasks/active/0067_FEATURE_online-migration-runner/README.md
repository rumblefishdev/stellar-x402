---
id: "0067"
title: "Run migrations on a live database without the one-transaction limit"
type: FEATURE
status: active
milestone: 1
related_adr: ["0012"]
related_tasks: ["0022", "0026", "0050"]
tags: [facilitator, persistence, deploy, priority-medium, effort-medium, platform]
links:
  - ../../../docs/adr/0012-facilitator-state-store.md
history:
  - date: "2026-10-23"
    status: backlog
    who: okarcz
    note: "Spawned from the review of 0050 (PR #61): its migration fits one transaction only on a small database."
  - date: "2026-10-26"
    status: active
    who: akot
    note: "Work starts."
---

# Run migrations on a live database without the one-transaction limit

## Summary

`migrate()` applies every pending migration in one transaction on the main pool, under its 10 s
`statement_timeout`. 0050 measured its `0004_spend_window` migration hitting that timeout at about
200 000 reservations. Once the public testnet deployment (0026) holds weeks of traffic, the next
change to these tables would fail the deploy, or stop `reserve` for a minute (the spike: 56 of 60
reserves failed while a 10-minute bound let it apply). Give `migrate()` a way to run such a
migration online.

## Context

- `apps/facilitator/src/adapters/postgres-schema.ts`: `migrate()` takes an advisory lock and
  applies the pending `MIGRATIONS` by name, in one Read Committed transaction with
  `lock_timeout = '10s'`. The pool sets `statement_timeout: 10_000`.
- 0050 (PR #61) records the limit in ADR 0012 and leaves the online runner for later; every
  database today holds few rows.
- 0026 is the first deployment whose data must survive a schema change.

## Implementation

The design is [S-online-runner-design](notes/S-online-runner-design.md) (plan v3), measured
first in a spike ([R-spike-results](notes/R-spike-results.md)). In short:

- A migration is transactional (`{ name, sql }`, as today) or online
  (`{ name, online: true, steps }`) with `sql`, `index` and `backfill` steps.
- Each step commits with a `schema_migrations` marker `name#<i>`; the next `migrate` skips the
  done steps. The migration's own row is written after its last step.
- ACCESS EXCLUSIVE steps wait at most 500 ms for their lock and retry `55P03` / `40P01`; index
  builds and `VALIDATE` wait without a lock timeout under a 30 min bound.
- Backfills: one keyset pass, a transaction a batch of 5 000, a 250 ms pause between batches.
- The runner holds a per-schema session advisory lock taken by polling, on a session with
  `client_connection_check_interval`.
- Online migrations run in the deploy's `migrate-<network>` service (ADR 0011 changes).
- Three PRs: the runner, its tests (T1–T5), the ADR amendments.

## Acceptance Criteria

- [ ] A migration that adds a NOT NULL column with a backfill and an index applies to a database
      with 1 000 000 reservations without hitting a timeout, while `reserve` keeps answering: no
      `reserve` error, and its latency compared with the same load without the migration
- [ ] A migration interrupted part way finishes on the next deploy (`pnpm migrate`) without
      manual steps
- [ ] ADR 0012 states how a migration chooses between the one-transaction and the online path
