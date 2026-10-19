import type pg from "pg";

/**
 * The PostgreSQL schema of the four ports (ADR 0012), as ordered migrations that `migrate` applies
 * once each.
 *
 * Expand/contract: a deploy runs the new migrations while the previous release still serves, so a
 * migration only expands the schema (new tables, nullable or defaulted columns, new indexes) in a
 * way that release still works with. Removing or renaming what it relies on (contract) waits for a
 * later migration, once no running release uses it. An applied migration is never edited or
 * reordered: add a new one.
 *
 * Every time is the app's clock, stored as `bigint` milliseconds; the SQL never reads the
 * database's clock.
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  {
    name: "0001_init",
    sql: `
CREATE TABLE settlements (
  key text PRIMARY KEY,
  network text NOT NULL,
  payer text NOT NULL,
  nonce text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL,
  payment_payload jsonb NOT NULL,
  payment_requirements jsonb NOT NULL,
  channel text,
  ledger bigint,
  fee_charged bigint,
  error_reason text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX settlements_non_final ON settlements (network, created_at)
  WHERE state IN ('claimed', 'signed', 'pending');

-- seq keeps a record's hashes oldest first.
CREATE TABLE settlement_hashes (
  hash text PRIMARY KEY,
  key text NOT NULL REFERENCES settlements (key) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX settlement_hashes_key ON settlement_hashes (key, seq);

CREATE TABLE leases (
  name text PRIMARY KEY,
  holder text NOT NULL,
  expires_at bigint NOT NULL
);

-- seq is the insertion order the listing pages by; an update keeps it.
CREATE TABLE catalog (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  network text NOT NULL,
  pay_to text NOT NULL,
  method text NOT NULL,
  resource_url text NOT NULL,
  key_version integer NOT NULL,
  ledger bigint NOT NULL CHECK (ledger >= 0),
  resource jsonb NOT NULL,
  PRIMARY KEY (network, pay_to, method, resource_url)
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at bigint NOT NULL
);

CREATE TABLE spend_reservations (
  id text PRIMARY KEY,
  amount bigint NOT NULL,
  at bigint NOT NULL
);
CREATE INDEX spend_reservations_at ON spend_reservations (at);
CREATE TABLE spend_reservation_scopes (
  scope text NOT NULL,
  id text NOT NULL REFERENCES spend_reservations (id) ON DELETE CASCADE,
  PRIMARY KEY (scope, id)
);
-- release's cascade finds a reservation's scopes by id, which the primary key can't look up.
CREATE INDEX spend_reservation_scopes_id ON spend_reservation_scopes (id);
-- One row per scope: its failure count and breaker, and the row a reservation locks.
CREATE TABLE spend_scopes (
  scope text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  breaker_until bigint
);
`,
  },
];

/** Serializes concurrent `migrate` runs, e.g. two tasks of one deploy; held until commit. */
const MIGRATE_LOCK = 0x78343032; // "x402"

/**
 * Applies the pending `MIGRATIONS` in order, in one Read Committed transaction, and resolves the
 * names it applied (`[]` when the schema is current). Any failure rolls back the whole run.
 * `now` stamps `applied_at`. `pool` comes from `createPool`, so a lost connection fails the run
 * instead of crashing the process.
 */
export async function migrate(pool: pg.Pool, now = Date.now()): Promise<string[]> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)",
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.name));
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.name));
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
        migration.name,
        now,
      ]);
    }
    await client.query("COMMIT");
    return pending.map((migration) => migration.name);
  } catch (error) {
    // A connection that can't roll back is dropped, not returned to the pool.
    await client.query("ROLLBACK").catch((rollbackError: Error) => (broken = rollbackError));
    throw error;
  } finally {
    client.release(broken);
  }
}
