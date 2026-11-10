---
id: "0050"
title: "Prune old rate-limit windows and spend reservations"
type: FEATURE
status: completed
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
  - date: "2026-10-26"
    status: active
    who: akot
    note: >
      Oskar's review of PR #61, after merging develop: `main()`'s tests now catch a pruner never
      started or never closed and a wrong rate-limit window; the boot test pins both prunes to the
      main pool by checkouts; `store_prune_failed` logs the rows already deleted; 0024 notes that
      the pruner's window must be the longest budget window; the sum is called an index range
      scan, since it is index-only only on all-visible pages. After develop brought 0023: its
      rate-limit test stores get `prune`, and the pubnet refusal no longer names 0050.
  - date: "2026-10-26"
    status: completed
    who: akot
    note: >
      PR #61 merged on 2026-10-26: 14 commits, 21 files. 0003_spend_window sums each spend window
      from the scope rows by index; a pruner in every process deletes expired rate-limit rows and
      reservations past max(2 x window, 7 days) in bounded batches.
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

- [x] Expired rate-limit rows and reservations past the longest window are deleted, in bounded
      batches
- [x] Nothing inside a live window is ever pruned (pinned by a test)
- [x] The spend-window sum reads only the window's rows (an index on `(scope, at)` or equivalent)

## Result

- `0004_spend_window`: `spend_reservation_scopes` gets `at` and `amount` (backfilled, NOT NULL)
  and `spend_reservation_scopes_window (scope, at) INCLUDE (amount)`. `WINDOW_SUM` reads that
  table alone; `reserve` writes the copy, `commit` updates both amounts in one statement.
- `SpendStore.commit(id, feeCharged)` keeps the reservation's time (the `now` argument is gone).
- `SpendStore.prune` and `RateLimitStore.prune(before, limit)` in both adapters; PostgreSQL
  deletes with `FOR UPDATE SKIP LOCKED` on the main pool.
- `src/pruner.ts`, started by `main()` and closed before the pools end: every minute ±10%,
  batches of 1000 per table until a short one or 1 s; spend horizon `max(2 × window, 7 days)`,
  rate limits one window. Logs `store_pruned` (`complete: false` when the budget ran out) and
  `store_prune_failed` (with the rows earlier batches deleted), counts
  `store_prune_failures_total`.
- ADR 0012 (throughput, the online-runner limit) and AD-18 (windows) updated. The pubnet refusal
  (`config.ts`, from 0023) waits only for 0024 and 0025 now.
- Tests: contract cases for both adapters (commit keeps the time, prune in both states and at
  the cutoff, rate-limit prune), PostgreSQL cases (backfill on a database with reservations, the
  sum not reading `spend_reservations`, prune skipping locked rows, both prunes on the main pool
  by checkouts), `pruner.test.ts`, and two `main()` cases (both tables pruned with the config's
  windows; the timer ticks under fake timers and stops at `close()`). Mutants each failing a
  case: the join back in the sum, commit skipping the copy, no SKIP LOCKED, `<=` at the cutoff, a
  `W + 1h` horizon, a 10-batch cap, `close()` not waiting for a tick; in `main()` no
  `pruner.start()`, no `pruner.close()`, the spend window or a fixed 60 s for rate limits; the
  rate-limit prune on its own pool.

## Design Decisions

Researched, then measured on PostgreSQL 18.3 with a simulated clock (10 000 and 100 000 payments
a day). The experiment scripts stayed local.

### From Plan

1. **Sum from a copy on the scope rows** (`at`, `amount`, `(scope, at) INCLUDE (amount)`). A day's
   window of 10 000: 1.9 ms instead of 4.9 ms, flat as the table grows (the join took 13 ms at 7×).
   Hourly buckets held the lock ~3× shorter (1.0–1.3 ms against 3.1–3.9 ms) but fail "counts only
   the rolling window": the edge hour counts whole, up to ~60× for the allowed 60 s window, and
   commit waits on buckets `reserve` holds. One row per (reservation, scope) needed a second
   duplicate check under the lock: +25% lock time. Buckets for whole hours on top of this index
   remain the way out if lock p99 passes ~25 ms.
2. **The adapter writes the copy, NOT NULL, no triggers.** Every write goes through
   `PostgresSpendStore`, one statement each; triggers cost nothing measurable but would hide the
   logic in SQL. NOT NULL makes a scope row without the copy fail instead of under-counting (a
   nullable copy under-counted 92% with old code writing). Triggers are the tool for a later
   online migration of these tables.
3. **A pruner in every process, no lease.** 3 pruners at once on a 600 000-row backlog: no errors
   or deadlocks. The cutoff comes from the service's own config, which a separate job could get
   out of step with.
4. **Every minute, batches of 1000, 1 s per table.** A 10-batch cap fell behind 20 000 new keys a
   minute (the table grew without end); the budget held it at its live keys, and drained a backlog
   5× faster without moving reserve's p99.
5. **Horizon `max(2 × window, 7 days)`.** With 25 hours, raising the window from 1 to 3 days
   counted 36% of the new window's spend for a day; a late commit found its reservation gone.
   10-day runs: the same lock time, 3.2× the disk (91 MB against 28 MB at 10 000 a day).
6. **No index on `rate_limits.reset_at`.** No change to `hit` latency in normal traffic or a flood;
   with sparse keys it cut HOT updates from 95% to 16%. The pruner's scan is 31–56 ms a minute at
   1 million keys, off the request path.
7. **One migration in one transaction.** It fits the 10 s timeout up to ~200 000 reservations
   (~20 days at 10 000 a day) and every database is below that: no durable store exists, and
   nothing writes spend rows before 0024. An online run (batched backfill, CONCURRENTLY, NOT VALID
   then VALIDATE, retries on 55P03 and 40P01, the app's lock order) ran on 1 million with no errors.

### Emerged

8. **`commit` keeps the reservation's time** (decided by Adam). Re-stamping at `now` with the
   longer horizon counted a fee paid a day before in today's window after an outage; the record
   holds no ledger close time to stamp with, and the reservation's time is within the
   transaction's time bound of it. `commit` has no caller yet, so the port drops `now`.
9. **Rate-limit pruning runs on the main pool**, so a flood's pruning takes no connection from
   `hit`.
10. **The migration's number:** `0004_spend_window`. It was `0003_spend_window`, as on develop
    when the PR opened; 0032 (#50) merged its `0003_catalog_type_seq` first, so this one follows
    it. 0019 (#57) also adds a `0003_*` and renumbers when it merges after this.
