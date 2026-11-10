---
title: "Spike: plan v2 measured on PostgreSQL 18 under reserve load"
type: research
status: mature
spawns: [notes/S-online-runner-design.md]
tags: [postgres, migrations, spike]
links: []
history:
  - date: 2026-10-27
    status: mature
    who: akot
    note: "Night run 26.10, A10 and A11 on 27.10"
---

# Spike: plan v2 measured on PostgreSQL 18 under reserve load

Every assumption of the online runner checked before writing it. The scripts stayed local
(`~/x402-0067-spike` on Adam's laptop): a prototype runner with the design's step markers, polled
lock, per-kind bounds, retries, keyset backfill and invalid-index repair; load from the repo's own
`PostgresSpendStore` (the old release, which doesn't know the new column); the baseline is the
repo's own `migrate()`.

## Setup

- PostgreSQL 18.6 in its own container, 2 CPUs and 1 GiB like production (ADR 0011), laptop SSD.
  Defaults: `shared_buffers` 160 MB, `max_wal_size` 1 GB, `checkpoint_timeout` 300 s.
- 1 000 000 reservations with **two** scope rows each (`global`, `payer:P<n>`, 1000 payers),
  2 000 000 scope rows, 637.5 MiB, every `at` 40 days back (outside every window). The default
  config has four scopes per reservation (`global`, `payer`, `payTo`, `asset`), so production has
  about twice the scope rows, backfill time and WAL measured here.
- Load: about 50 `reserve` a second from 4 workers, half committed, 10% released; 30 s before the
  migration, 15 s after. "Contended": another session holds a lock on the table 1.5 s every 4 s.
- The migration under test is plan v2's D4 on `spend_reservation_scopes`: `ADD COLUMN c`,
  `SET DEFAULT 0`, `ADD CONSTRAINT c_nn NOT NULL c NOT VALID`, keyset backfill by `(scope, id)`,
  `VALIDATE CONSTRAINT`, `CREATE INDEX CONCURRENTLY`.

## Results

| | Question | Result |
|---|---|---|
| A1 | NOT NULL recipe on PG 18 | 11/11. `NOT VALID` takes ACCESS EXCLUSIVE for ms; `VALIDATE` takes SHARE UPDATE EXCLUSIVE and DML from other sessions goes through; after it `attnotnull` is true, no `SET NOT NULL` needed |
| A2 | `lock_timeout` vs `CREATE INDEX CONCURRENTLY` | cuts it: 55P03 after 1.0 s (open writer) and 1.4 s (old snapshot), INVALID index left. With `lock_timeout` 0 and a 3 s statement bound: 57014, also INVALID |
| A3 | runner lock vs CIC | a session blocked in `pg_advisory_lock` stalls CIC (57014 at 6 s); polling `pg_try_advisory_lock` doesn't (360 ms) |
| A4 | orphaned migration backend | with `client_connection_check_interval` the backend is gone 0.6–1.0 s after its client; without it a backend waiting on a lock stays and keeps the advisory lock |
| A5 | metadata-only DDL on 2 M rows | 2.6 / 2.6 / 1.4 ms, no rewrite. `ADD COLUMN d DEFAULT 7` gives all 2 M rows 7 at once, so a `WHERE d IS NULL` backfill updates nothing |
| A6 | D4 under load, `lock_timeout` 200/500/1000/2000 ms × quiet/contended × 2 | 16/16 applied and verified; 2 `reserve` errors in ~68 000 calls (one run); max over 2 s in 4 runs (up to 5.9 s), all inside the backfill, with no DDL retries and no relation to `lock_timeout`. Retries: 3 a run at 200 ms, 2 at 500 ms |
| baseline | today's `migrate()` on the same change | 10 s bound: 57014, rolled back, 8 of 12 reserves failed. 10 min bound: applied in 57.8 s, **56 of 60** reserves failed 55P03, max 6.0 s |
| A7 | backfill batch 1k/2k/5k/10k | 5 000: p95 211 ms a batch, 86.5 s in all. WAL 1.0–1.2 GiB for 2 M rows whatever the batch; table 466 → 573–637 MiB |
| A8 | `pg_terminate_backend` after step 3, mid-backfill, mid-`VALIDATE`, mid-CIC | 4/4 finished by the next run, done steps skipped, INVALID index dropped and rebuilt, no reserve errors |
| A9 | two runners at once | one applied all steps; the other polled 101.8 s, found the migration applied, did nothing |
| A10 | backfill pause between batches, 6 runs each | 5000:50 ms: 1 error, max 4.0 and 4.3 s in two runs, 71–102 s. 5000:250 ms: 0 errors, max ≤ 1.9 s in 5 runs and 2.8 s in one, 139–175 s. 5000:1000 ms (1 run): 0.3 s, 443 s |
| A11 | the same load for 170 s, no migration, 3 runs | ~25 500 reserves, 0 errors, max 70–383 ms, none over 1 s; WAL fsync 0.6–3.0 ms average (1.9–7.2 ms with a backfill) |

## What the reserve tail is

The migration's locks cost nothing measurable. The tail comes from the backfill's writes:

1. A batch of 5 000 rows writes about 3 MiB of WAL, more after each checkpoint (full-page images).
2. WAL is one stream: a `reserve`'s `COMMIT` returns only once everything written before it is
   flushed, the backfill's batch included.
3. Under sustained writes the disk has latency spikes; a slow checkpoint makes them worse
   (26.10 20:39: `sync=11.5 s`, longest file 6 s), but they happen without one (27.10 08:35:49,
   a 2.9 s `COMMIT` with no checkpoint running).
4. That `reserve` holds the `global` scope row meanwhile; every other `reserve` queues on it and
   gives up after `RESERVE_LOCK_TIMEOUT` (2 s) with 55P03.

A11 shows the same machine without the backfill never stalls a reserve past 0.4 s. Slowing the
backfill removes the errors and shortens the tail, but doesn't bound it.

This is a property of the spend design (0050) as much as of migrations: any `COMMIT` that takes
over 2 s, for any reason (another tenant's writes on the shared disk, autovacuum), fails every
`reserve` queued behind the `global` row.

## The production disk

The server's block-device statistics over 30 days (one sample a second per disk), read on 27.10;
nothing was run or written on the server. Its two NVMe disks are in RAID 1, and ClickHouse,
Docker and so our Postgres and its WAL share them (ADR 0011).

- Write traffic about 8 MiB/s, the disks busy about 0.5% of the time, an average write
  0.6–0.7 ms.
- Of 2.5 million seconds, a second's average write took over 10 ms in about 0.27% of them, over
  50 ms in about 195, never over 200 ms; the worst second averaged 112 ms.
- The slow seconds are ClickHouse writing 400–500 MiB/s, most of them around 00:00 UTC every
  day, the most on Monday at 00:00.

The laptop stalled a `COMMIT` for 2–6 s; this disk's worst second is about 20× shorter. Not
seen from here: a single request slower than its second's average, the cache flushes `fsync`
sends, and the disk model (whether its write cache survives a power loss); a shell on the
server would show them.

