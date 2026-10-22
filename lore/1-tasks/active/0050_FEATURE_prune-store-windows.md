---
id: "0050"
title: "Prune old rate-limit windows and spend reservations"
type: FEATURE
status: active
milestone: 1
related_adr: ["0012"]
related_tasks: ["0022", "0023", "0024"]
tags: [facilitator, persistence, priority-high, effort-small, discovery]
links:
  - ../../../docs/adr/0012-facilitator-state-store.md
history:
  - date: "2026-10-13"
    status: backlog
    who: akot
    note: "Spawned from 0022 future work: pruning was kept out of 0022."
  - date: "2026-10-20"
    status: backlog
    who: akot
    note: "Renumbered from 0042, which develop already uses for the MCP Claude Desktop task (Karol's review)."
  - date: "2026-10-22"
    status: active
    who: akot
    note: "Work starts."
---

# Prune old rate-limit windows and spend reservations

## Summary

The PostgreSQL stores from 0022 never delete anything. Rate-limit rows are keyed per client IP and
spend reservations are kept forever, so both tables grow without bound on a public endpoint, and
the spend-window sum gets slower on every settlement. Needed before mainnet: at 10 000 payments a
day (ADR 0011's mainnet sizing) a 1-day window alone holds about 10 000 reservations.

## Context

- 0022 built the four PostgreSQL adapters. The user decided pruning was out of its scope.
- `reserve` sums each window by joining `spend_reservation_scopes (scope, id)` to
  `spend_reservations` and then filtering on `at`. For the `global` scope it visits every
  reservation ever made, while holding that scope's row lock (0022 final review).

## Implementation

- Delete `rate_limits` rows whose `reset_at` has passed, and spend reservations older than the
  longest configured spend window. Their scope rows go with them through the cascade.
- Run it in small batches from the service on a timer, or as a scheduled job (pick one with 0026).
- Make the window sum use an index: copy `at` into `spend_reservation_scopes` and index
  `(scope, at)`, as a new expand-only migration.
- A contract or adapter case: pruning never removes a reservation still inside a window.
- Option from 0022's third review, to verify rather than a decision (a better approach may exist):
  - `commit` re-stamps `spend_reservations.at`. While the expand-only migration that copies `at`
    runs, the previous release keeps serving and doesn't update the copy. Committed spend then
    leaves the window early and `reserve` under-counts. Options: write the copy in `commit` from
    the first release that has it, keep the original `at` on commit, or decide before the first
    durable deploy and put the column in `0001_init`.
  - Measured for 0022's decision 22 (PostgreSQL 18.3, `global` plus one payer scope): the
    per-scope sum takes about 48 ms at 100 000 reservations and 160–320 ms at 1 000 000, under the
    global lock. Copying only `at` with an index `(scope, at)` doesn't help while the window is
    full (it still joins every row in it). What does: `at` and `amount` copied with
    `(scope, at) INCLUDE (amount)`, 13 ms at 100 000 and 144 ms at 1 000 000 for a full window;
    or hourly buckets `spend_buckets (scope, hour, amount)`, 0.04–0.19 ms at any size, exact to
    the hour at the window's edge, kept by `reserve`, `commit` and `release`. Both need pruning.
  - The migration runner applies everything in one transaction with the pool's 10 s
    `statement_timeout`. A backfill or an index on a large table needs a
    `{ transaction: false }` flag (for `CREATE INDEX CONCURRENTLY`), a migrate pool without
    `statement_timeout`, and a short `lock_timeout` with retry.

## Acceptance Criteria

- [ ] Expired rate-limit rows and reservations past the longest window are deleted, in bounded
      batches
- [ ] Nothing inside a live window is ever pruned (pinned by a test)
- [ ] The spend-window sum reads only the window's rows (an index on `(scope, at)` or equivalent)
