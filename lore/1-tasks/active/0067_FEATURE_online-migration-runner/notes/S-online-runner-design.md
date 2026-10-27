---
title: "Online migration runner: design (plan v3)"
type: synthesis
status: mature
spawned_from: notes/R-spike-results.md
spawns: []
tags: [postgres, migrations, design]
links:
  - ../../../../../docs/adr/0011-facilitator-hosting.md
  - ../../../../../docs/adr/0012-facilitator-state-store.md
history:
  - date: 2026-10-26
    status: developing
    who: akot
    note: "Plan v2 after the GSD plan-checker and BMAD architecture reviews"
  - date: 2026-10-27
    status: mature
    who: akot
    note: "Plan v3: spike results folded in (backfill pace, AC1 against a control, four scopes)"
---

# Online migration runner: design (plan v3)

v2 was reviewed by GSD `gsd-plan-checker` (3 blockers, 4 high) and BMAD `bmad-architecture`
(approve with changes) on 26.10; every blocker and high finding is folded in. v3 adds what the
spike measured ([R-spike-results](R-spike-results.md)). Decisions Adam took are marked
**[decided]**.

## Invariants

What every future migration author relies on.

1. A migration is **transactional** (`{ name, sql }`, as today) or **online**
   (`{ name, online: true, steps }`).
2. **Prefix rule:** after every step boundary, and at the end, the previous release (N-1) works
   unchanged. Online migrations are expand-only; contract waits for release N+1.
3. **Step markers [decided]:** each step commits with a `schema_migrations` row `name#<i>`. A `sql`
   step runs in one transaction with its marker, so it applies exactly once; authors write no
   guards. `index` and `backfill` steps are runner-owned and re-entrant; their marker is written
   when they finish.
4. The migration's own row (`name`) is written after its last step. Release N may rely on the
   whole migration, since the deploy starts it only after `migrate` succeeds.
5. **Lock contract:** an ACCESS EXCLUSIVE step's `lock_timeout` (500 ms) plus its hold time stays
   below the app's shortest lock timeout (`RESERVE_LOCK_TIMEOUT`, 2 s); a test asserts the
   inequality. Only `55P03` and `40P01` are retried (backoff of a few × `lock_timeout`, jitter,
   bounded attempts); any other error stops the run. Spike: no reserve error came from these
   steps; 500 ms needed 2 retries a run with a session holding the table every 4 s.
6. **Statement bounds per kind:** transactional group 10 s (the ADR rule below); `sql` step a few
   seconds; backfill batch ≈ 5 s; `index` and `VALIDATE` (SHARE UPDATE EXCLUSIVE, DML continues):
   `lock_timeout = 0`, `statement_timeout` 30 min. A short `lock_timeout` aborts CIC and leaves an
   INVALID index (A2).
7. **Backfill:** one keyset pass over the key (row comparison `(a, b) > ($1, $2)`), a transaction a
   batch, idempotent by predicate (`c IS NULL`), a **pause between batches (default 250 ms,
   batch 5 000)**, then one check query (no rows left). New rows are covered by a DEFAULT set with
   `SET DEFAULT` before the backfill (never in `ADD COLUMN`, which fills every row at once, A5) or
   by a trigger. The pause is what keeps the backfill's WAL off `reserve`'s commits (A10, A11).
8. A migration is **frozen once it has started** on any environment (merged to the deploy
   branch), not only once applied: markers point at step numbers.

## Design

### D1. Runner

- `migrate(pool, now, migrations)` keeps its signature. It checks one client out of the pool
  (keeping `createPool`'s guards: Read Committed on connect, the error listener) and sets the
  session: `application_name = 'x402-migrate'`, `client_connection_check_interval = '5s'` (A4: a
  dead runner's backend otherwise keeps the lock and blocks the next deploy).
- Consecutive transactional migrations share one transaction, as today; an online migration
  splits the group. The group runs under the same lock contract as a `sql` step (500 ms, retried)
  instead of today's 10 s `lock_timeout`: a group's `ALTER` waiting 10 s would queue `reserve`
  past its own timeout, and a group is a transaction, so a retry repeats it whole (emerged).
- `migrate`'s lock is two keys, `MIGRATE_LOCK` and the schema's hash, where the old runner took
  one. A deploy runs one `migrate` at a time under its `flock`, so an old and a new runner never
  overlap.
- Applied names are the rows without `#`. `migrate` still resolves the names it applied.
- Step kinds:
  - `sql(statement)`: one transaction with its marker; the lock retry wraps the transaction.
  - `index({ name, table, definition })`: checked schema-qualified (`to_regclass`,
    `pg_index.indisvalid` / `indisready`); an invalid leftover is dropped with
    `DROP INDEX CONCURRENTLY`, then `CREATE INDEX CONCURRENTLY`. Outside a transaction.
  - `validate({ table, constraint })`: `VALIDATE CONSTRAINT` under invariant 6's long bound.
    Runner-owned and re-entrant like `index`, since a `sql` step's 5 s bound and 500 ms lock
    timeout don't fit a scan of millions of rows (emerged while building).
  - `backfill({ table, key, set, where, batch, pauseMs })`: invariant 7.
- NOT NULL on PG 18 (`postgres:18` in compose and CI): `ADD CONSTRAINT c_nn NOT NULL c NOT VALID`,
  backfill, `VALIDATE CONSTRAINT c_nn` (A1). No CHECK → SET NOT NULL → DROP.

### D2. Lock between runners

- A session advisory lock, taken by polling `pg_try_advisory_lock` with sleeps, **outside any
  transaction** (A3: a session blocked in `pg_advisory_lock` holds a snapshot that CIC waits for),
  with a bounded total wait.
- Key: `MIGRATE_LOCK` combined with `hashtext(current_schema())`, so test files on their own
  schemas (`testDatabase`) don't serialize on one database-wide key. Released in `finally`.

### D3. Where it runs [decided: in the deploy]

- The deploy's `migrate-<network>` one-off service runs online migrations too, before the old
  facilitator stops. ADR 0011:419 ("index build … outside the deploy as a planned step") changes.
- A log line per step and every N batches (rows, elapsed), so a long deploy reads as busy in the
  deploy unit's journal.
- `x402-deploy@` is a oneshot with no start timeout; its `flock` holds later deploys. ADR 0011
  records a total cap and the headroom: WAL about 2.4 GiB per million reservations with four
  scopes, the table growing about a third, and pgBackRest shipping that WAL as it closes. The
  mainnet ceiling goes to 0038.
- Both networks' databases share the server's disks with the production ClickHouse: an online
  migration runs on testnet first and outside mainnet's busy hours.

### D4. AC1's test migration

Passed through `migrate(…, migrations)`; no production migration. Target
`spend_reservation_scopes`, which `reserve` writes while it holds the scope row lock:

1. `sql`: `ALTER TABLE spend_reservation_scopes ADD COLUMN c bigint`
2. `sql`: `ALTER … ALTER COLUMN c SET DEFAULT 0`
3. `sql`: `ALTER … ADD CONSTRAINT c_nn NOT NULL c NOT VALID`
4. `backfill`: key `(scope, id)`, `SET c = <expr> WHERE c IS NULL`
5. `validate`: `ALTER … VALIDATE CONSTRAINT c_nn`
6. `index`: `CREATE INDEX CONCURRENTLY … (c)`

### D5. ADR text (AC3)

> A migration is transactional if, on the largest database it will meet, it finishes inside the
> transactional bound (10 s) while holding write-blocking locks; otherwise it is online. Each
> online step is one non-blocking or sub-second-lock operation: a single `ALTER`, a keyset
> backfill batch, `CREATE INDEX CONCURRENTLY`, `NOT VALID` then `VALIDATE`. The previous release
> works after every step. A failed transactional group leaves the schema as it was; a failed
> online migration leaves a valid expand prefix that the next deploy finishes.

Also amend ADR 0012:70 (transaction-level → session-level lock), ADR 0012:75–79 and
ADR 0011:242–245, 419–423 (the one-transaction rationale, index builds outside the deploy, the
migration service's bounds = invariants 5–6).

### D6. Tests (on `testDatabase`)

- T1 (AC1): seed `spend_reservations` with **four** scope rows each by `generate_series`, `at`
  outside every window; run D4 while a loop calls `reserve` (old code: the column unknown to it).
  Assert: the backfill updated every seeded row; no `reserve` error; reserves completed during
  every step; the reserve p99 during the migration within a bound of the same loop's p99 before
  it (not a fixed max: the tail is the disk's, A11); rows inserted mid-migration have `c`; the
  constraint validated; the index valid. In the suite at a scale that keeps it to seconds; the
  1 000 000 run is the same test with a scale variable, run by hand for AC1 and recorded here.
- T2 (AC2): real interruptions, `pg_terminate_backend` on `application_name = 'x402-migrate'`,
  after step 3, mid-backfill and mid-index. The next `migrate` finishes; assert the markers, no
  NULLs, `indisvalid`, the constraint validated, the `name` row.
- T3: an INVALID index leftover is dropped and rebuilt.
- T4: another session holds a conflicting lock; the ALTER step waits at most its `lock_timeout`,
  retries, no `reserve` errors.
- T5: two `migrate` at once on one schema: one applies, the other waits on the polled lock and
  applies nothing.
- The existing migrate cases (`postgres.test.ts`) keep passing.

### D7. Delivery

Branch `lore-0067-online-migration-runner` from `develop` (0064 merged in #68). Three PRs, split by
risk:

1. Runner: session and client, polled lock, lock contract and retries, per-kind bounds, the online
   kind with `sql`, `index` and `backfill` steps and markers.
2. Tests T1–T5.
3. ADR 0011 and 0012 amendments, the task's AC text, the runbook headroom.

## Rejected

- node-pg-migrate, graphile-migrate, Flyway, Sqitch, pgroll: none supplies the part needed
  (resumable batched backfill, the lock contract, invalid-index repair); each adds a second
  system or runtime for about five migrations.
- Online steps in a separate pre-deploy job: more infrastructure for one instance.
- A manual planned step (ADR 0011 today): fails AC2.
- Resuming migrations at boot: breaks "`pnpm migrate` is the only path that changes the schema".
- A progress table with cursors: markers plus the idempotent predicate suffice at 1 M.
- Per-step `done` guard queries: every author writes one and can get it wrong.
- A fixed max-latency bound in AC1: the tail is the disk's, so it is compared with a control.

## Open

- The production disk: model and RAID, when ClickHouse writes, host metrics, `pg_test_fsync` on
  the data volume. Decides whether 250 ms holds on production.
- Smaller batches at the same pace (1 000 every 50 ms): less WAL per `COMMIT`; A7's batch of 1 000
  had the shortest reserve tail (158 ms). Untested under A10's setup.
- `wal_compression` would shrink the full-page images a backfill writes after each checkpoint.
- The `global` row: any `COMMIT` over 2 s fails the queued reserves, migration or not. Raise with
  Karol as its own task (0050's design).
