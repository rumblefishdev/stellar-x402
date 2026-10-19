---
title: "PostgreSQL mapping of the four ports (from the local spike)"
type: generation
status: mature
spawned_from: S-state-store-decision.md
spawns: []
tags: [persistence, postgres, schema, 0022]
links:
  - ../../../../../apps/facilitator/src/ports
  - ../../../../../apps/facilitator/test/port-contracts.ts
history:
  - date: "2026-10-12"
    status: mature
    who: akot
    note: "Schema and statements that passed the 0031 contract suites (23 cases) on PostgreSQL 18.6; a starting point for 0022."
---

# PostgreSQL mapping of the four ports

This mapping passed `port-contracts.ts` as of task 0031 (23 cases, including the ledger-ordered
catalog upsert), unchanged, on PostgreSQL 18.6 with `pg` 8.23.1 and a 20-connection pool. The
rate-limit statement below is the corrected form (see RateLimitStore).

General rules:
- Every time comes from the app's `now` and is stored as `bigint` milliseconds.
- The isolation level is Read Committed everywhere.
- Every transaction starts with `BEGIN ISOLATION LEVEL READ COMMITTED`, so a role or parameter
  group default can't change it.
- Leave the int8 parser (OID 20) at its default: convert per column, `BigInt()` for stroops and
  `Number()` for times, ledger and counts.

## Schema

```sql
CREATE TABLE settlements (
  key text PRIMARY KEY, network text NOT NULL, payer text NOT NULL, nonce text NOT NULL,
  fingerprint text NOT NULL, state text NOT NULL,
  payment_payload jsonb NOT NULL, payment_requirements jsonb NOT NULL,
  channel text, ledger bigint, fee_charged bigint, error_reason text,
  created_at bigint NOT NULL, updated_at bigint NOT NULL);
CREATE INDEX settlements_non_final ON settlements (network, created_at)
  WHERE state IN ('claimed', 'signed', 'pending');
CREATE TABLE settlement_hashes (
  hash text PRIMARY KEY, key text NOT NULL REFERENCES settlements ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY);          -- oldest first
CREATE INDEX settlement_hashes_key ON settlement_hashes (key, seq);
CREATE TABLE leases (name text PRIMARY KEY, holder text NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE catalog (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- insertion order; an update keeps it
  network text, pay_to text, method text, resource_url text,
  key_version integer NOT NULL, ledger bigint NOT NULL, resource jsonb NOT NULL,
  PRIMARY KEY (network, pay_to, method, resource_url));
CREATE TABLE rate_limits (key text PRIMARY KEY, count integer NOT NULL, reset_at bigint NOT NULL);
CREATE TABLE spend_reservations (id text PRIMARY KEY, amount bigint NOT NULL, at bigint NOT NULL);
CREATE TABLE spend_reservation_scopes (
  scope text NOT NULL, id text NOT NULL REFERENCES spend_reservations ON DELETE CASCADE,
  PRIMARY KEY (scope, id));
CREATE TABLE spend_scopes (scope text PRIMARY KEY, failures integer NOT NULL DEFAULT 0,
  breaker_until bigint);                             -- also the reserve's lock rows
```

## SettlementStore

- **`claim`**
  - `INSERT … ON CONFLICT (key) DO NOTHING RETURNING *`.
  - If no row comes back, run a separate `SELECT` by key. Under Read Committed a new statement sees
    the winner, which has committed by then.
- **`addHash`** is one statement in the common path:
  - `WITH rec AS (SELECT … FOR UPDATE)` locks the record;
  - inserts into `settlement_hashes` with `ON CONFLICT (hash) DO NOTHING`, only while the state is
    non-final;
  - moves `claimed` to `signed` and sets `updated_at`;
  - returns the state and the hash's owner.

  When the hash already exists but its owner isn't visible in that statement's snapshot (it
  committed while `ON CONFLICT` waited), a second statement re-reads `settlement_hashes`.

  Results: `false` if the record is final or missing; a no-op if the hash is already on this key.
  If the hash belongs to another key, the spike throws. That is an open contract question for
  0022.
- **`transition`**
  - The forward-only check happens in TS, then
    `UPDATE … SET state, provided fields, updated_at WHERE key = $1 AND state = $2 RETURNING *`.
  - Hashes are read afterwards in a separate statement. A subquery inside the `UPDATE` would use the
    snapshot from before the lock wait.
- **`findByHash`**: look up the key in `settlement_hashes` by primary key, then load the record.
- **`listNonFinal`** uses the partial index, ordered by `created_at, key`.
- **Lease**
  - Acquire:
    `INSERT INTO leases … ON CONFLICT (name) DO UPDATE SET holder, expires_at WHERE leases.holder = EXCLUDED.holder OR leases.expires_at < $now RETURNING …`.
  - Renew: `UPDATE … WHERE name AND holder AND expires_at >= $now`.
  - Release: `DELETE … WHERE name AND holder`.
  - Never use a session advisory lock.

## CatalogStore

- **`upsert`** runs in one short transaction:
  - `INSERT … ON CONFLICT DO NOTHING RETURNING seq` means `inserted`.
  - Otherwise `SELECT … FOR UPDATE`, then apply the ledger rule and the `accepts` merge in TS (the
    same code as the memory adapter), then `UPDATE` without touching `seq`.
  - Reject an invalid `ledger` before the query.
- **`list`**
  - `WITH m AS (SELECT seq, resource FROM catalog WHERE filters…)`.
  - `total` is `count(*)` over `m`. The page is `m ORDER BY seq LIMIT/OFFSET`.
  - `count(*) OVER()` would return no total once the offset is past the end.
  - The `extensions` filter is `resource->'extensions' ? $key`.

## RateLimitStore

- TS computes `resetAt = (floor(now / windowMs) + 1) * windowMs`.
- Then:

  ```sql
  INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, $2)
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN rate_limits.reset_at >= EXCLUDED.reset_at
                 THEN rate_limits.count + 1 ELSE 1 END,
    reset_at = GREATEST(rate_limits.reset_at, EXCLUDED.reset_at)
  RETURNING count, reset_at;
  ```

- The columns must be qualified: unqualified `reset_at` is ambiguous and the statement fails.
- `GREATEST` keeps a hit from an older window (another ECS task, clock skew) from resetting the
  count. The spike and the memory adapter still use `=`, so 0022 adds a contract case for it.

## SpendStore

- **`reserve`** runs as one Read Committed transaction:
  1. Insert the reservation with `ON CONFLICT (id) DO NOTHING`. If it already existed, the call is
     a no-op.
  2. Insert any missing scope rows in sorted order, then lock them with
     `SELECT … ORDER BY scope FOR UPDATE`.
  3. Sum each rolling window, `at > now - windowMs AND at <= now`.
  4. If any limit is exceeded, roll back and return that scope. Otherwise insert the
     reservation-scope rows.

  - At Repeatable Read, the scope locks don't stop write skew, because a lock wait doesn't refresh
    the snapshot. That comes from the PostgreSQL docs and was reproduced separately on 18.6.
  - In the spike, removing the locks at Read Committed made the contract's concurrent case fail 3
    runs out of 3.
- **`commit`** updates the amount and `at`.
- **`release`** deletes, and the delete cascades.
- **`used`** is the same window sum as in `reserve`.
- **Failures and breakers** are upserts on `spend_scopes`.

## Not covered by the contracts yet (for 0022)

- `addHash` with a hash another key owns. Keying hashes by hash makes "reject" the natural answer.
- A rate-limit hit from an older window. It must not reset the count.
- `reserve` with `limits` in a different scope order. A concurrent lease acquire. List past the end
  of a non-empty catalog. The int64-max round trip.
- Clearing a field in `transition`, and the order of `listNonFinal`.
- `jsonb` reorders payload keys, so a fingerprint must never be recomputed from the stored payload.
  A `\u0000` in a payload makes the jsonb insert throw, while memory accepts it.
- The spend window should be `at > now - windowMs` with no upper bound. A reservation stamped by an
  ECS task whose clock runs ahead must still count.
- `openBreaker` should keep the later `until` (`GREATEST`), so another ECS task can't close a
  breaker early.
- `resource->'extensions' ? $key` also matches arrays and strings. Guard it with
  `jsonb_typeof(...) = 'object'`.
- Validate `offset` and `limit` in the route. A negative value throws in SQL but slices from the end
  in memory. The identity `seq` is assigned at insert, so offset pages can shift under concurrent
  inserts.
- `CREATE INDEX CONCURRENTLY` (T2 indexes) can't run inside the migration transaction. It needs its
  own connection under a session-level lock.
- After a point-in-time restore, `/settle` stays closed until `listNonFinal` and an on-chain re-check
  of the lost window finish.
