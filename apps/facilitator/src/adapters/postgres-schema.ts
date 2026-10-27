import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import type { Logger } from "../logger.js";

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
 * A migration that wouldn't finish inside one transaction's bound on the largest database it meets
 * is online (`OnlineMigration`, 0067); every other one is transactional.
 *
 * Every time is the app's clock, stored as `bigint` milliseconds; the SQL never reads the
 * database's clock.
 */
export const MIGRATIONS: readonly Migration[] = [
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

-- seq is the insertion order the listing pages by; an update keeps it. type and extension_keys
-- copy the resource's filter fields, so a listing filters without reading resource.
CREATE TABLE catalog (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  network text NOT NULL,
  pay_to text NOT NULL,
  method text NOT NULL,
  resource_url text NOT NULL,
  key_version integer NOT NULL,
  ledger bigint NOT NULL CHECK (ledger >= 0),
  resource jsonb NOT NULL,
  type text,
  extension_keys text[] NOT NULL,
  PRIMARY KEY (network, pay_to, method, resource_url)
);
CREATE INDEX catalog_extension_keys ON catalog USING gin (extension_keys);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at bigint NOT NULL
);

-- A committed reservation's amount is a fee paid on-chain, which release keeps. A status rather
-- than a flag, so refusing a reserve after its release (0024) can add 'released'.
CREATE TABLE spend_reservations (
  id text PRIMARY KEY,
  amount bigint NOT NULL,
  at bigint NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed'))
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
  {
    // 0009: when `/settle` first answered a record's `success` (AD-6). Nullable, so the release
    // before it keeps working.
    name: "0002_success_answered",
    sql: "ALTER TABLE settlements ADD COLUMN success_answered_at bigint;",
  },
  {
    // 0032: answers a listing's type filter, matched or not, without scanning the catalog. IF NOT
    // EXISTS for a database built from 0032's branch, whose 0001_init carried it.
    name: "0003_catalog_type_seq",
    sql: "CREATE INDEX IF NOT EXISTS catalog_type_seq ON catalog (type, seq);",
  },
  {
    // 0050: each scope row carries its reservation's time and amount, so a window's sum reads only
    // the window's index entries instead of joining every reservation the scope ever had. `reserve`
    // and `commit` write both copies in one statement. NOT NULL is safe because no release writes
    // spend rows yet (0024 wires the store); one that wrote scope rows without the copy would
    // fail, never under-count. In one transaction: every database holds few rows (0050, E17).
    name: "0004_spend_window",
    sql: `
ALTER TABLE spend_reservation_scopes ADD COLUMN at bigint, ADD COLUMN amount bigint;
UPDATE spend_reservation_scopes rs SET at = r.at, amount = r.amount
  FROM spend_reservations r WHERE r.id = rs.id;
ALTER TABLE spend_reservation_scopes ALTER COLUMN at SET NOT NULL, ALTER COLUMN amount SET NOT NULL;
CREATE INDEX spend_reservation_scopes_window ON spend_reservation_scopes (scope, at) INCLUDE (amount);
`,
  },
];

/** Runs in one transaction with the transactional migrations next to it, as before 0067. */
export interface TransactionalMigration {
  name: string;
  sql: string;
}

/**
 * Too large for one transaction (ADR 0012): steps, each committed with a `name#<i>` marker in
 * `schema_migrations`, so a run that stops part way resumes at the first unmarked step. The
 * migration's own row is written after its last step. The previous release must keep working
 * after every step, and a migration that started anywhere is never edited: markers count steps.
 */
export interface OnlineMigration {
  name: string;
  online: true;
  steps: readonly OnlineStep[];
}

export type Migration = TransactionalMigration | OnlineMigration;

export type OnlineStep =
  /**
   * One statement that holds ACCESS EXCLUSIVE for milliseconds: an `ALTER TABLE` that changes only
   * the catalog (`ADD COLUMN` without a default, `SET DEFAULT`, `ADD CONSTRAINT … NOT VALID`). It
   * commits with its marker, so it applies exactly once.
   */
  | { kind: "sql"; sql: string }
  /** `VALIDATE CONSTRAINT`: scans under SHARE UPDATE EXCLUSIVE, so writes go on meanwhile. */
  | { kind: "validate"; table: string; constraint: string }
  /**
   * `CREATE INDEX CONCURRENTLY <name> ON <table> <definition>`. A build that stopped leaves an
   * INVALID index, which is dropped and built again.
   */
  | { kind: "index"; name: string; table: string; definition: string }
  /**
   * `UPDATE <table> t SET <set> WHERE <where>`, one keyset pass over `key` in batches of `batch`
   * (5 000), each in its own transaction, `pauseMs` (250) apart. `set` and `where` see the row as
   * `t`. `where` must match only rows still to fill (`t.c IS NULL`), so a pass repeated after an
   * interruption skips what is done; rows written meanwhile need a default, set in an earlier
   * step (never in `ADD COLUMN`, which fills every row at once). Fails if a row still matches.
   */
  | {
      kind: "backfill";
      table: string;
      key: readonly string[];
      set: string;
      where: string;
      batch?: number;
      pauseMs?: number;
    };

export interface MigrateOptions {
  /** Logs each online step and the backfills' progress. */
  logger?: Pick<Logger, "info">;
  /** How long to wait for another run on the same schema (30 minutes). */
  lockWaitMs?: number;
}

/**
 * Serializes `migrate` runs on one schema, e.g. two tasks of one deploy: the first key of the
 * session lock, the schema's `hashtext` the second.
 */
export const MIGRATE_LOCK = 0x78343032; // "x402"
const LOCK_POLL_MS = 250;

/**
 * How long a statement that takes ACCESS EXCLUSIVE waits for it. While it waits, every `reserve`
 * on the table queues behind it, so it gives up well before `reserve` does
 * (`RESERVE_LOCK_TIMEOUT_MS`) and tries again later.
 */
export const STEP_LOCK_TIMEOUT_MS = 500;
/** `lock_timeout` and a deadlock: the statement did nothing, so trying again is safe. */
const RETRYABLE = new Set(["55P03", "40P01"]);
const LOCK_ATTEMPTS = 20;

const GROUP_STATEMENT_TIMEOUT_MS = 10_000;
const SQL_STEP_STATEMENT_TIMEOUT_MS = 5_000;
const BATCH_STATEMENT_TIMEOUT_MS = 5_000;
/** `VALIDATE`, index builds and a backfill's last check: they scan the table but block no writes. */
const LONG_STATEMENT_TIMEOUT_MS = 30 * 60_000;

const BACKFILL_BATCH = 5_000;
/** Between batches: each batch's WAL delays every `COMMIT` after it, `reserve`'s included (0067). */
const BACKFILL_PAUSE_MS = 250;
const BACKFILL_LOG_EVERY = 50;

const CREATE_SCHEMA_MIGRATIONS =
  "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)";

/**
 * Applies the pending migrations in order and resolves the names it applied (`[]` when the schema
 * is current). Consecutive transactional migrations share one Read Committed transaction, so a
 * failure among them rolls all of them back. An online migration runs its unmarked steps; one
 * that fails leaves the steps before it applied, and the next run continues from there.
 *
 * Runs on one connection of `pool`, which comes from `createPool`, holding a session lock per
 * schema, and closes it at the end, so no other caller inherits its settings. `now` stamps
 * `applied_at`. Tests pass their own `migrations`.
 */
export async function migrate(
  pool: pg.Pool,
  now = Date.now(),
  migrations: readonly Migration[] = MIGRATIONS,
  options: MigrateOptions = {},
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SET application_name = 'x402-migrate'");
    // A run whose client died ends within seconds instead of holding the lock against the next
    // deploy.
    await client.query("SET client_connection_check_interval = '5s'");
    await lock(client, options.lockWaitMs ?? 30 * 60_000);
    const done = await markers(client);
    const pending = migrations.filter((migration) => !done.has(migration.name));
    const applied: string[] = [];
    for (let i = 0; i < pending.length;) {
      const next = pending[i]!;
      if (isOnline(next)) {
        await runOnline(client, next, done, now, options.logger);
        applied.push(next.name);
        i++;
        continue;
      }
      const group: TransactionalMigration[] = [];
      for (let m = pending[i]; m && !isOnline(m); m = pending[++i]) group.push(m);
      await retryingLocks(() =>
        transaction(client, STEP_LOCK_TIMEOUT_MS, GROUP_STATEMENT_TIMEOUT_MS, async () => {
          await client.query(CREATE_SCHEMA_MIGRATIONS);
          for (const migration of group) {
            await client.query(migration.sql);
            await mark(client, migration.name, now);
          }
        }),
      );
      applied.push(...group.map((migration) => migration.name));
    }
    return applied;
  } finally {
    // The session lock goes with the connection.
    client.release(true);
  }
}

function isOnline(migration: Migration): migration is OnlineMigration {
  return "online" in migration && migration.online;
}

/**
 * Polls, never waits in `pg_advisory_lock`: a session blocked there holds a snapshot that every
 * `CREATE INDEX CONCURRENTLY` waits for, the running migration's included (0067).
 */
async function lock(client: pg.PoolClient, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, hashtext(coalesce(current_schema(), ''))) AS locked",
      [MIGRATE_LOCK],
    );
    if (rows[0]!.locked) return;
    if (Date.now() >= deadline)
      throw new Error(`another migrate run held the lock for ${waitMs} ms`);
    await sleep(LOCK_POLL_MS);
  }
}

/** Every row of `schema_migrations`: applied migrations, and `name#<i>` for done online steps. */
async function markers(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (!rows[0]!.present) return new Set();
  const names = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(names.rows.map((row) => row.name));
}

async function mark(client: pg.PoolClient, name: string, now: number): Promise<void> {
  await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
    name,
    now,
  ]);
}

async function runOnline(
  client: pg.PoolClient,
  migration: OnlineMigration,
  done: ReadonlySet<string>,
  now: number,
  logger: MigrateOptions["logger"],
): Promise<void> {
  await client.query(CREATE_SCHEMA_MIGRATIONS);
  for (const [index, step] of migration.steps.entries()) {
    const marker = `${migration.name}#${index + 1}`;
    if (done.has(marker)) continue;
    const started = Date.now();
    const retries = await runStep(client, step, marker, now, (fields) =>
      logger?.info("migration_backfill", { migration: migration.name, step: index + 1, ...fields }),
    );
    logger?.info("migration_step", {
      migration: migration.name,
      step: index + 1,
      kind: step.kind,
      ms: Date.now() - started,
      retries,
    });
  }
  await mark(client, migration.name, now);
}

/** Runs one step and writes its marker; resolves how many lock waits it retried. */
async function runStep(
  client: pg.PoolClient,
  step: OnlineStep,
  marker: string,
  now: number,
  progress: (fields: Record<string, number>) => void,
): Promise<number> {
  switch (step.kind) {
    case "sql":
      return retryingLocks(() =>
        transaction(client, STEP_LOCK_TIMEOUT_MS, SQL_STEP_STATEMENT_TIMEOUT_MS, async () => {
          await client.query(step.sql);
          await mark(client, marker, now);
        }),
      );
    case "validate":
      await long(client, `ALTER TABLE ${step.table} VALIDATE CONSTRAINT ${step.constraint}`);
      await mark(client, marker, now);
      return 0;
    case "index": {
      const { rows } = await client.query<{ valid: boolean }>(
        `SELECT i.indisvalid AND i.indisready AS valid FROM pg_index i
         WHERE i.indexrelid = to_regclass(quote_ident(current_schema()) || '.' || $1)`,
        [step.name],
      );
      if (rows[0] && !rows[0].valid) await long(client, `DROP INDEX CONCURRENTLY ${step.name}`);
      if (!rows[0]?.valid)
        await long(
          client,
          `CREATE INDEX CONCURRENTLY ${step.name} ON ${step.table} ${step.definition}`,
        );
      await mark(client, marker, now);
      return 0;
    }
    case "backfill": {
      const retries = await backfill(client, step, progress);
      await mark(client, marker, now);
      return retries;
    }
  }
}

async function backfill(
  client: pg.PoolClient,
  step: Extract<OnlineStep, { kind: "backfill" }>,
  progress: (fields: Record<string, number>) => void,
): Promise<number> {
  const keys = step.key.join(", ");
  const params = step.key.map((_, i) => `$${i + 1}`).join(", ");
  const join = step.key.map((column) => `t.${column} = b.${column}`).join(" AND ");
  const last = step.key.map((column) => `${column} DESC`).join(", ");
  const batch = step.batch ?? BACKFILL_BATCH;
  const started = Date.now();
  let cursor: unknown[] | undefined;
  let retries = 0;
  let batches = 0;
  let rows = 0;
  for (;;) {
    // The batch's last key comes from the batch, not from the rows updated, so the pass moves on
    // past rows that need nothing.
    const sql = `WITH b AS (
        SELECT ${keys} FROM ${step.table} ${cursor ? `WHERE (${keys}) > (${params})` : ""}
        ORDER BY ${keys} LIMIT ${batch}
      ), u AS (
        UPDATE ${step.table} t SET ${step.set} FROM b WHERE ${join} AND (${step.where}) RETURNING 1
      )
      SELECT (SELECT count(*) FROM u)::int AS updated, ${keys}
      FROM (SELECT ${keys} FROM b ORDER BY ${last} LIMIT 1) l`;
    let row: Record<string, unknown> | undefined;
    retries += await retryingLocks(() =>
      transaction(client, STEP_LOCK_TIMEOUT_MS, BATCH_STATEMENT_TIMEOUT_MS, async () => {
        row = (await client.query(sql, cursor ?? [])).rows[0];
      }),
    );
    if (!row) break;
    batches++;
    rows += row.updated as number;
    cursor = step.key.map((column) => row![column]);
    if (batches % BACKFILL_LOG_EVERY === 0) progress({ batches, rows, ms: Date.now() - started });
    await sleep(step.pauseMs ?? BACKFILL_PAUSE_MS);
  }
  progress({ batches, rows, ms: Date.now() - started });
  const { rows: left } = await long<{ left: boolean }>(
    client,
    `SELECT EXISTS (SELECT 1 FROM ${step.table} t WHERE ${step.where}) AS left`,
  );
  if (left[0]!.left) throw new Error(`backfill of ${step.table} left rows where ${step.where}`);
  return retries;
}

/**
 * Retries `run` while it fails on a lock wait, backing off so the queue it let through drains.
 * Resolves the number of retries.
 */
async function retryingLocks(run: () => Promise<void>): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return attempt - 1;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "string" || !RETRYABLE.has(code) || attempt === LOCK_ATTEMPTS)
        throw error;
      const backoff = Math.min(5_000, STEP_LOCK_TIMEOUT_MS * 2 ** Math.min(attempt, 4));
      await sleep(backoff * (0.5 + Math.random()));
    }
  }
}

/**
 * One Read Committed transaction with its own lock and statement bounds. A connection that can't
 * roll back fails the run's next query; `migrate` closes it either way.
 */
async function transaction(
  client: pg.PoolClient,
  lockTimeoutMs: number,
  statementTimeoutMs: number,
  run: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    await run();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * A statement outside any transaction (`CREATE INDEX CONCURRENTLY` can't run in one) that takes no
 * lock blocking writes, so it waits for locks without a timeout: a `lock_timeout` would abort an
 * index build and leave it INVALID (0067). `createPool`'s client-side timeout is raised with it.
 */
async function long<R extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.PoolClient,
  text: string,
): Promise<pg.QueryResult<R>> {
  await client.query(`SET lock_timeout = 0; SET statement_timeout = ${LONG_STATEMENT_TIMEOUT_MS}`);
  // pg reads `query_timeout` per query too; its types know only the client's.
  const query = { text, query_timeout: LONG_STATEMENT_TIMEOUT_MS + 5_000 } as pg.QueryConfig;
  try {
    return await client.query<R>(query);
  } finally {
    // Fails only on a broken connection, which then fails the run's next query.
    await client.query("RESET lock_timeout; RESET statement_timeout").catch(() => {});
  }
}
