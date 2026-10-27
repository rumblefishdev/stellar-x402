---
id: "0067"
title: "Run migrations on a live database without the one-transaction limit"
type: FEATURE
status: active
milestone: 1
related_adr: ["0012"]
related_tasks: ["0022", "0026", "0050", "0075"]
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
- ACCESS EXCLUSIVE steps and transactional groups wait at most 500 ms for each lock and retry
  `55P03` / `40P01`, and end at 1.5 s (`transaction_timeout`); index
  builds and `VALIDATE` wait without a lock timeout under a 30 min bound.
- Backfills: one keyset pass, a transaction a batch of 5 000, a 250 ms pause between batches.
- The runner holds a per-schema session advisory lock taken by polling, on a session with
  `client_connection_check_interval`.
- Online migrations run in the deploy's `migrate-<network>` service (ADR 0011 changes).
- Three PRs: the runner, its tests (T1–T5), the ADR amendments.

## Acceptance Criteria

- [x] A migration that adds a NOT NULL column with a backfill and an index applies to a database
      with 1 000 000 reservations without a step failing on a timeout, while `reserve` keeps
      answering: under 1% of `reserve` calls fail during the migration, and the run records
      `reserve`'s latency, its errors and the retried batches against the same load before it
- [x] A migration interrupted part way finishes on the next deploy (`pnpm migrate`) without
      manual steps
- [x] ADR 0012 states how a migration chooses between the one-transaction and the online path

## Result

- `postgres-schema.ts`: `Migration` is transactional (`{ name, sql }`) or online
  (`{ name, online: true, steps }`), with `sql`, `validate`, `index` and `backfill` steps and a
  `name#<i>` marker per step. `migrate(pool, now, migrations, { logger, lockWaitMs })` polls a
  session lock per schema on one connection it closes at the end. `main.ts` passes the logger
  (`migration_step`, `migration_backfill`).
- `test/migrate.test.ts`: the AC1 migration under four `reserve` loops; runs killed at the
  backfill's first batch, part way through it, in `VALIDATE` and in an index build, finished by
  the next run; a held lock retried while `reserve` waits at most the step's lock timeout; a
  batch that ran out of time retried; racing runs, the per-schema lock, the group split, a
  backfill that leaves rows; a transactional group whose lock another session holds; `VALIDATE`
  and an index build that outlast the pool's statement timeout; a run whose client went away
  while a step waits; a table rewrite in a group or a `sql` step, and a group of short
  statements, failing at their bound while `reserve` answers. At the suite's scale AC1 allows no
  failed `reserve`; the 1% budget holds at `MIGRATE_SCALE`. Mutants each failing a case: no
  invalid-index repair, no lock retry, no batch timeout retry, a group without its lock retry or
  with a 10 s lock timeout, a long step without its raised statement or client timeout, no
  `client_connection_check_interval`, no `transaction_timeout`, 10 s statements.
- AC1 at 1 000 000 reservations with four scopes each (`MIGRATE_SCALE=1000000`, compose
  PostgreSQL 18 on Adam's laptop, 27.10): applied in 4 min 45 s; steps 1–3 took 3–4 ms; the
  backfill of 4 000 000 rows 282 s. `reserve` before: 471 calls, p50 8 ms, p99 13 ms. During:
  21 942 calls, p50 48 ms, p99 144 ms, max 7.4 s, and 7 errors (`55P03`, 0.03%), all between
  249 s and 259 s inside the backfill, when the runner held no lock `reserve` takes: a disk stall
  slowed a `COMMIT` holding the `global` scope row, and the reserves queued on it gave up
  ([R-spike-results](notes/R-spike-results.md)). The first 1 M run stopped on a batch's
  statement timeout, which a batch now retries. Two more runs: 3 errors during the index build;
  and, with `reserve` committing asynchronously (`synchronous_commit = off`), 3 errors from one
  8 s stall of the whole database. That change bought nothing and cost AD-18 a crash's last
  0.6 s of reservations, so it was reverted. A control run after the review (an `sql` step
  bounded at 1 s, retries reported): applied in 4 min 43 s, the backfill 279 s, `VALIDATE`
  0.3 s, the index 4 s, no step or batch retried; `reserve` before 494 calls, p50 8 ms, p99
  22 ms, during 21 600 calls, p50 50 ms, p99 145 ms, max 3.9 s, and 2 errors (`55P03`, 0.009%)
  at 256 s and 258 s inside the backfill.
- The production disk over 30 days: an average write
  0.6 ms, the worst second 112 ms, against the laptop's 2–8 s stalls.
- ADR 0012 (the rule, the runner's lock, markers and bounds, the backfill's WAL and `reserve`)
  and ADR 0011 (long migrations in the deploy, disk headroom, shared disks).
