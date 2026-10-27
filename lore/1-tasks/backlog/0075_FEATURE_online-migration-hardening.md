---
id: "0075"
title: "Harden the online migration runner before its first real migration"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0012"]
related_tasks: ["0024", "0026", "0067"]
tags: [facilitator, persistence, deploy, priority-medium, effort-medium, platform]
links:
  - ../../../docs/adr/0012-facilitator-state-store.md
  - ../active/0067_FEATURE_online-migration-runner/README.md
history:
  - date: "2026-10-27"
    status: backlog
    who: akot
    note: >
      Spawned from the review of 0067 (PR #73): M2, m1 and m2, then the BMAD review's patches
      left out of #73. Nothing is at risk while MIGRATIONS holds no online migration; this task
      closes before the first one lands.
---

# Harden the online migration runner before its first real migration

## Summary

0067's runner applies online migrations step by step, but `MIGRATIONS` holds none yet. Three
gaps from its review matter only once one does: markers that can't tell an edited step from the
one that ran, an INVALID index a failed build leaves for every write to maintain, and a load in
AC1's test without the writes that touch the rows a backfill locks. Close them before an online
migration is added to `MIGRATIONS`.

## Context

- `apps/facilitator/src/adapters/postgres-schema.ts`: a step's marker is `name#<i>`, its index,
  and nothing checks that the steps behind the markers are the ones that ran.
  - A migration `[A, B, C]` stopped after B, then edited to `[A, X, B, C]`: the next run skips X,
    which never ran, and runs B a second time.
  - A step that fails every time (a wrong `set`, a backfill that leaves rows) fails every deploy
    at that step, and ADR 0012 forbids the edit that would fix it.
- `CREATE INDEX CONCURRENTLY` that runs out of its 30 minutes, or fails in its last phase, leaves
  an INVALID index with `indisready = true`: every write to the table maintains it, and a UNIQUE
  one enforces itself, until the next deploy drops and rebuilds it.
- AC1's test (`test/migrate.test.ts`) runs four `reserve` loops only. `commit`, `release` and
  `prune` write the `spend_reservation_scopes` rows a backfill batch locks: they wait out a batch,
  up to its 5 s bound, and a batch at a scope's boundary can deadlock with a `commit`. The batch
  usually loses (its 500 ms `lock_timeout` is below `deadlock_timeout`), but a `commit` that waited
  more than 0.5 s first is the victim. Not reproduced; from reading the locks.

## Implementation Plan

### Step 1: A marker records its step

Store a hash of each step's definition with its marker. A run whose marked step's hash differs
from the code stops before any step. Steps after the last marker may change: ADR 0012 says so,
replacing "a migration that has started anywhere is never edited".

### Step 2: A failed index build drops what it left

When `CREATE INDEX CONCURRENTLY` fails, drop the index it left (`DROP INDEX CONCURRENTLY IF
EXISTS`) before the error goes up; the next run builds it again.

### Step 3: AC1's load writes what the app writes

Add `commit` and `release` loops to AC1's test load, and check that 0024's commit path retries
`40P01`.

### Step 4: A step says when it starts and why it failed

`runOnline` logs a step only once it succeeds: a 30-minute index build is silent in the deploy's
journal until it ends, and a failed step reaches it as PostgreSQL's message alone. Log the start,
and log or wrap the error with the migration, the step and its kind.

### Step 5: A backfill's columns can't be ambiguous

The batch's CTE `b` carries the key columns under their own names, so a `set` or `where` that
names one without `t.` (`c = length(id)`) fails as ambiguous. Alias them (`k0`, `k1`).

### Step 6: The branches no test reaches

- An index step that meets a valid index without its marker (a run stopped after the build):
  an unconditional `CREATE INDEX CONCURRENTLY` passes the suite today.
- The `migration_backfill` progress log every 50 batches.
- A lock wait that runs out of its 20 attempts fails the run; cheap once `MigrateOptions` can set
  the attempts.

## Acceptance Criteria

- [ ] A run whose marked step was edited fails before running anything, naming the step; editing
      a step after the last marker applies the edited step
- [ ] An index build that fails with an error leaves no index behind; one whose run was killed
      leaves an INVALID index the next run rebuilds
- [ ] AC1's test runs `commit` and `release` alongside `reserve`, and fewer than 1% of the calls
      fail during the migration
- [ ] ADR 0012 states which steps of a started migration may change
- [ ] A step's start, and its failure with the migration and step named, reach the log
- [ ] A backfill's `set` and `where` may name a key column without `t.`
- [ ] Tests cover the valid-but-unmarked index, the backfill's progress log and running out of
      lock attempts

## Notes

- BMAD review of #73, 27.10: P6 (unmarked valid index), P7 (step logs), P8 (progress log), P10
  (ambiguous key columns), P11 (this task's index AC) and W1 (lock attempts) moved here; W2 (a
  migration's total cap, abort and hotfix procedure, the runbook's headroom check) belongs to
  0038 and 0026.
- Review findings: PR #73 review, 27.10 (M2, m1, m2). m3 (`57014` is also `pg_cancel_backend`'s
  code), m4 (`to_regclass` read before `CREATE TABLE IF NOT EXISTS`) and m5 (test gaps) stayed
  out; pick them up here if cheap.
