---
id: "0067"
title: "Run migrations on a live database without the one-transaction limit"
type: FEATURE
status: backlog
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
---

# Run migrations on a live database without the one-transaction limit

## Summary

`migrate()` applies every pending migration in one transaction on the main pool, under its 10 s
`statement_timeout`. 0050 measured its `0003_spend_window` migration hitting that timeout at about
200 000 reservations. Once the public testnet deployment (0026) holds weeks of traffic, the next
change to these tables would fail the boot. Give `migrate()` a way to run such a migration online.

## Context

- `apps/facilitator/src/adapters/postgres-schema.ts`: `migrate()` takes an advisory lock and
  applies the pending `MIGRATIONS` by name, in one Read Committed transaction with
  `lock_timeout = '10s'`. The pool sets `statement_timeout: 10_000`.
- 0050 (PR #61) records the limit in ADR 0012 and leaves the online runner for later; every
  database today holds few rows.
- 0026 is the first deployment whose data must survive a schema change.

## Implementation

- Let a migration opt out of the shared transaction (e.g. `{ transaction: false }`), so it can
  use `CREATE INDEX CONCURRENTLY` and `NOT VALID` / `VALIDATE CONSTRAINT`.
- Backfills run in batches, each in its own short transaction.
- Run migrations on a connection without the pool's `statement_timeout`, keeping `lock_timeout`
  short and retrying when it fires.
- A migration that stops part way resumes on the next boot; record what makes each step safe to
  re-run.

## Acceptance Criteria

- [ ] A migration that adds a NOT NULL column with a backfill and an index applies to a database
      with 1 000 000 reservations without hitting a timeout, while `reserve` keeps answering
- [ ] A migration interrupted part way finishes on the next boot without manual steps
- [ ] ADR 0012 states how a migration chooses between the one-transaction and the online path
