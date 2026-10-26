import type { StellarNetwork } from "@stellar-x402/config";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import pg from "pg";
import {
  HashConflictError,
  type AttemptBounds,
  type AttemptState,
  type AttemptUpdate,
  type CatalogEntry,
  type CatalogPage,
  type CatalogQuery,
  type CatalogStore,
  type ChannelLease,
  type ClaimResult,
  type NewSettlement,
  type RateLimitHit,
  type RateLimitStore,
  type ReserveResult,
  type SettlementAttempt,
  type SettlementKey,
  type SettlementRecord,
  type SettlementState,
  type SettlementStore,
  type SettlementUpdate,
  type SpendReservation,
  type SpendScope,
  type SpendStore,
  type Stores,
  type UpsertOutcome,
} from "../ports/index.js";
import {
  NON_FINAL_STATES,
  assertLedger,
  assertStroops,
  attemptRankSql,
  extensionKeys,
  isFinal,
  isForward,
  mergeCatalogEntry,
  windowEnd,
} from "./rules.js";

/**
 * PostgreSQL adapters of the four ports (AD-7, ADR 0012), on the schema in `postgres-schema.ts`.
 * They share one pool, except `reserve`, the rate limiter's `hit` and the catalog's `list`, which
 * can each run on their own; concurrent calls run on separate connections.
 *
 * - Every time comes from the caller; the SQL never reads the database's clock.
 * - Every statement runs at Read Committed, so a role or server default can't change it: each
 *   connection sets it as its session default before the pool hands it out, and is closed if it
 *   can't; each transaction sets it again explicitly.
 *   Each statement sees what committed before it started, which is why a value read after a lock
 *   wait is read in a new statement.
 * - int8 columns come back as strings: `BigInt()` for stroops, `Number()` for times, ledgers and
 *   counts. No global type parser is installed.
 * - `reserve` runs on `reservePool`. Reservations queue on the global scope's lock while holding a
 *   connection, so on the shared pool a burst of them would leave none for `claim`, `addHash` or
 *   `hit`. Its own small pool keeps that queue off the others.
 * - `hit` runs on `pools.rateLimits`, for the same reason: one client's flood queues its hits on
 *   one key's row lock, and the rate limiter must still answer when settlements hold the main pool.
 * - `list` runs on `pools.discovery`: `/discovery/resources` is public, and a burst of listings
 *   must not take the connections `/settle` needs. Catalog writes stay on the main pool. `main()`
 *   gives that pool a short statement timeout, so a few slow listings can't hold it for long.
 * - `prune` runs on the main pool for both, so pruning a flood's keys takes nothing from `hit`.
 */
export function postgresStores(
  pool: pg.Pool,
  pools: { reserve?: pg.Pool; rateLimits?: pg.Pool; discovery?: pg.Pool } = {},
): Stores {
  return {
    settlements: new PostgresSettlementStore(pool),
    catalog: new PostgresCatalogStore(pool, pools.discovery ?? pool),
    rateLimits: new PostgresRateLimitStore(pools.rateLimits ?? pool, pool),
    spend: new PostgresSpendStore(pool, pools.reserve ?? pool),
  };
}

/**
 * A pool with the facilitator's limits: a statement runs at most `statementTimeoutMs` (10 s by
 * default) on the server and a query waits at most 5 s longer in the client. `onError` receives errors of idle connections, which would
 * otherwise crash the process. Every connection runs at Read Committed, or is closed and its
 * caller's query fails, and keeps an error listener while checked out, where pg-pool removes its
 * own: a connection lost mid-transaction then fails its queries instead of crashing the process.
 */
export function createPool(
  connectionString: string,
  onError: (error: Error) => void,
  max = 10,
  statementTimeoutMs = 10_000,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 5_000,
    idle_in_transaction_session_timeout: 10_000,
    application_name: "x402-facilitator",
    // The pool waits for this before handing the client out; if it throws, it closes the client.
    onConnect: async (client) => {
      try {
        await client.query(
          "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED",
        );
      } catch (error) {
        throw new Error("could not set Read Committed on a new connection", { cause: error });
      }
    },
  });
  pool.on("error", onError);
  pool.on("connect", (client) => {
    client.on("error", () => {});
  });
  return pool;
}

/** Runs `fn` in one Read Committed transaction on one connection; any throw rolls it back. */
export async function inTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A connection that can't roll back is dropped, not returned to the pool.
    await client.query("ROLLBACK").catch((rollbackError: Error) => (broken = rollbackError));
    throw error;
  } finally {
    client.release(broken);
  }
}

/** The non-final states as SQL literals; constants, so the partial index matches. */
const NON_FINAL_SQL = NON_FINAL_STATES.map((state) => `'${state}'`).join(", ");

const SELECT_RECORD = `SELECT s.*, coalesce(
    (SELECT array_agg(h.hash ORDER BY h.seq) FROM settlement_hashes h WHERE h.key = s.key), '{}'
  ) AS hashes
  FROM settlements s`;

interface SettlementRow {
  key: string;
  network: string;
  payer: string;
  nonce: string;
  fingerprint: string;
  state: string;
  payment_payload: SettlementRecord["paymentPayload"];
  payment_requirements: SettlementRecord["paymentRequirements"];
  channel: string | null;
  ledger: string | null;
  fee_charged: string | null;
  error_reason: string | null;
  /** Absent on a database `0002_success_answered` hasn't reached (`SELECT s.*`). */
  success_answered_at?: string | null;
  /** Absent on a database `0005_settlement_attempts` hasn't reached (`SELECT s.*`). */
  version?: number;
  created_at: string;
  updated_at: string;
  hashes?: string[];
}

function toRecord(row: SettlementRow, hashes = row.hashes ?? []): SettlementRecord {
  const record: SettlementRecord = {
    key: row.key as SettlementKey,
    network: row.network as StellarNetwork,
    payer: row.payer,
    nonce: row.nonce,
    fingerprint: row.fingerprint,
    state: row.state as SettlementState,
    hashes,
    version: row.version ?? 0,
    paymentPayload: row.payment_payload,
    paymentRequirements: row.payment_requirements,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.channel !== null) record.channel = row.channel;
  if (row.ledger !== null) record.ledger = Number(row.ledger);
  if (row.fee_charged !== null) record.feeCharged = BigInt(row.fee_charged);
  if (row.error_reason !== null) record.errorReason = row.error_reason;
  if (row.success_answered_at != null) record.successAnsweredAt = Number(row.success_answered_at);
  return record;
}

interface AttemptRow {
  hash: string;
  state: string | null;
  max_time: string | null;
  max_ledger: string | null;
  channel: string | null;
  error_code: string | null;
  updated_at: string | null;
}

function toAttempt(row: AttemptRow): SettlementAttempt {
  const attempt: SettlementAttempt = {
    hash: row.hash,
    state: (row.state ?? "stored") as AttemptState,
  };
  if (row.max_time !== null) attempt.maxTime = Number(row.max_time);
  if (row.max_ledger !== null) attempt.maxLedger = Number(row.max_ledger);
  if (row.channel !== null) attempt.channel = row.channel;
  if (row.error_code !== null) attempt.errorCode = row.error_code;
  if (row.updated_at !== null) attempt.updatedAt = Number(row.updated_at);
  return attempt;
}

/**
 * Moves the named attempts of `$1` forward, each on its own, and stamps `$2`; `$3` is the updates
 * as JSON. The rank comparison drops an update that isn't ahead, so concurrent writers can only
 * move an attempt on.
 */
const MARK_ATTEMPTS = `UPDATE settlement_hashes h
  SET state = u.state,
      channel = coalesce(u.channel, h.channel),
      error_code = coalesce(u.error_code, h.error_code),
      updated_at = $2
  FROM jsonb_to_recordset($3::jsonb) AS u(hash text, state text, channel text, error_code text)
  WHERE h.hash = u.hash AND h.key = $1
    AND ${attemptRankSql("u.state")} > ${attemptRankSql("h.state")}`;

const attemptsJson = (updates: AttemptUpdate[]) =>
  JSON.stringify(
    updates.map(({ hash, state, channel, errorCode }) => ({
      hash,
      state,
      channel: channel ?? null,
      error_code: errorCode ?? null,
    })),
  );

/** The optional fields a transition may set, and their columns. */
const UPDATE_COLUMNS = {
  channel: "channel",
  ledger: "ledger",
  feeCharged: "fee_charged",
  errorReason: "error_reason",
} as const;

export class PostgresSettlementStore implements SettlementStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(settlement: NewSettlement): Promise<ClaimResult> {
    const s = settlement;
    const { rows } = await this.pool.query<SettlementRow>(
      `INSERT INTO settlements (key, network, payer, nonce, fingerprint, state, payment_payload,
         payment_requirements, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $8)
       ON CONFLICT (key) DO NOTHING
       RETURNING *`,
      [
        s.key,
        s.network,
        s.payer,
        s.nonce,
        s.fingerprint,
        JSON.stringify(s.paymentPayload),
        JSON.stringify(s.paymentRequirements),
        s.createdAt,
      ],
    );
    if (rows[0]) return { claimed: true, record: toRecord(rows[0], []) };
    // The conflict waited for the winner to commit, so a new statement sees its row.
    const existing = await this.get(s.key);
    if (!existing) throw new Error("settlement claim conflicted but the existing record is gone");
    return { claimed: false, existing };
  }

  async get(key: SettlementKey): Promise<SettlementRecord | undefined> {
    const { rows } = await this.pool.query<SettlementRow>(`${SELECT_RECORD} WHERE s.key = $1`, [
      key,
    ]);
    return rows[0] && toRecord(rows[0]);
  }

  async findByHash(hash: string): Promise<SettlementRecord | undefined> {
    const { rows } = await this.pool.query<SettlementRow>(
      `${SELECT_RECORD} WHERE s.key = (SELECT key FROM settlement_hashes WHERE hash = $1)`,
      [hash],
    );
    return rows[0] && toRecord(rows[0]);
  }

  /**
   * One statement locks the record, adds the hash while the record is non-final, and moves
   * `claimed` to `signed`; it also returns the hash's owner as its snapshot sees it.
   */
  async addHash(
    key: SettlementKey,
    hash: string,
    updatedAt: number,
    bounds?: AttemptBounds,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{
      state: string | null;
      added: boolean;
      owner: string | null;
    }>(
      `WITH rec AS (
         SELECT key, state FROM settlements WHERE key = $1 FOR UPDATE
       ), ins AS (
         INSERT INTO settlement_hashes (hash, key, state, max_time, max_ledger, updated_at)
         SELECT $2, key, 'stored', $4::bigint, $5::bigint, $3 FROM rec
         WHERE state IN (${NON_FINAL_SQL})
         ON CONFLICT (hash) DO NOTHING
         RETURNING key
       ), upd AS (
         UPDATE settlements s
         SET state = CASE WHEN s.state = 'claimed' THEN 'signed' ELSE s.state END,
             version = s.version + 1,
             updated_at = $3
         FROM ins WHERE s.key = ins.key
         RETURNING s.key
       )
       SELECT (SELECT state FROM rec) AS state,
              EXISTS (SELECT 1 FROM upd) AS added,
              (SELECT key FROM settlement_hashes WHERE hash = $2) AS owner`,
      [key, hash, updatedAt, bounds?.maxTime ?? null, bounds?.maxLedger ?? null],
    );
    const { state, added, owner } = rows[0]!;
    // 1. A missing or final record.
    if (state === null || isFinal(state as SettlementState)) return false;
    // 4. Appended.
    if (added) return true;
    // The hash existed. An owner that committed while the insert waited on it isn't in this
    // statement's snapshot, so a new statement reads it.
    const resolved =
      owner ??
      (
        await this.pool.query<{ key: string }>(
          "SELECT key FROM settlement_hashes WHERE hash = $1",
          [hash],
        )
      ).rows[0]?.key;
    // 2. Already on this record.
    if (resolved === key) return true;
    // 3. On another record.
    if (resolved !== undefined) throw new HashConflictError(hash);
    throw new Error("transaction hash conflicted but no record owns it");
  }

  async attempts(key: SettlementKey): Promise<SettlementAttempt[]> {
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT hash, state, max_time, max_ledger, channel, error_code, updated_at
       FROM settlement_hashes WHERE key = $1 ORDER BY seq`,
      [key],
    );
    return rows.map(toAttempt);
  }

  async markAttempts(
    key: SettlementKey,
    updates: AttemptUpdate[],
    updatedAt: number,
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const { rowCount } = await this.pool.query(MARK_ATTEMPTS, [
      key,
      updatedAt,
      attemptsJson(updates),
    ]);
    return rowCount ?? 0;
  }

  /** One conditional `UPDATE`: the row lock lets exactly one of several callers set it. */
  async markSuccessAnswered(key: SettlementKey, at: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE settlements SET success_answered_at = $2
       WHERE key = $1 AND state = 'success' AND success_answered_at IS NULL`,
      [key, at],
    );
    return rowCount === 1;
  }

  async transition(
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
    expectedVersion?: number,
  ): Promise<SettlementRecord | undefined> {
    if (update.feeCharged !== undefined) assertStroops(update.feeCharged, "feeCharged");
    const { attempts } = update;
    if (attempts?.length)
      return inTransaction(this.pool, async (client) => {
        await client.query(MARK_ATTEMPTS, [key, update.updatedAt, attemptsJson(attempts)]);
        return this.moveState(client, key, expected, update, expectedVersion);
      });
    return this.moveState(this.pool, key, expected, update, expectedVersion);
  }

  private async moveState(
    db: pg.Pool | pg.PoolClient,
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
    expectedVersion?: number,
  ): Promise<SettlementRecord | undefined> {
    if (!isForward(expected, update.state)) return undefined;
    const values: unknown[] = [key, expected, update.state, update.updatedAt];
    const sets = ["state = $3", "updated_at = $4"];
    // Like the memory adapter, a field given as `undefined` clears the column.
    for (const [field, column] of Object.entries(UPDATE_COLUMNS))
      if (field in update) {
        const value = update[field as keyof typeof UPDATE_COLUMNS];
        values.push(typeof value === "bigint" ? value.toString() : (value ?? null));
        sets.push(`${column} = $${values.length}`);
      }
    // Re-checked on the row `addHash` committed, if it held the lock: its version is the new one.
    let where = "key = $1 AND state = $2";
    if (expectedVersion !== undefined) {
      values.push(expectedVersion);
      where += ` AND version = $${values.length}`;
    }
    const { rows } = await db.query<SettlementRow>(
      `UPDATE settlements SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
      values,
    );
    if (!rows[0]) return undefined;
    // A separate statement: a hash subquery in the UPDATE would use its snapshot from before the
    // row lock wait.
    const hashes = await db.query<{ hash: string }>(
      "SELECT hash FROM settlement_hashes WHERE key = $1 ORDER BY seq",
      [key],
    );
    return toRecord(
      rows[0],
      hashes.rows.map((row) => row.hash),
    );
  }

  async listNonFinal(network: StellarNetwork): Promise<SettlementRecord[]> {
    const { rows } = await this.pool.query<SettlementRow>(
      `${SELECT_RECORD} WHERE s.network = $1 AND s.state IN (${NON_FINAL_SQL})
       ORDER BY s.created_at, s.key`,
      [network],
    );
    return rows.map((row) => toRecord(row));
  }

  /** A row upsert, never an advisory lock: the lease must outlive any one connection. */
  async acquireLease(
    name: string,
    holder: string,
    ttlMs: number,
    now: number,
  ): Promise<ChannelLease | undefined> {
    const { rows } = await this.pool.query<{ name: string; holder: string; expires_at: string }>(
      `INSERT INTO leases (name, holder, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE leases.holder = EXCLUDED.holder OR leases.expires_at < $4
       RETURNING name, holder, expires_at`,
      [name, holder, now + ttlMs, now],
    );
    const row = rows[0];
    return row && { name: row.name, holder: row.holder, expiresAt: Number(row.expires_at) };
  }

  async renewLease(name: string, holder: string, ttlMs: number, now: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE leases SET expires_at = $3 WHERE name = $1 AND holder = $2 AND expires_at >= $4",
      [name, holder, now + ttlMs, now],
    );
    return rowCount === 1;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    await this.pool.query("DELETE FROM leases WHERE name = $1 AND holder = $2", [name, holder]);
  }
}

/** `resource` and the filter columns copied from it, which every write keeps in step. */
const resourceColumns = (resource: DiscoveryResource) => [
  JSON.stringify(resource),
  resource.type ?? null,
  extensionKeys(resource),
];

const CATALOG_KEY_WHERE = "network = $1 AND pay_to = $2 AND method = $3 AND resource_url = $4";

export class PostgresCatalogStore implements CatalogStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly listPool: pg.Pool = pool,
  ) {}

  /** Inserts, or locks the stored entry and applies the shared merge to it, in one transaction. */
  async upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    assertLedger(entry.ledger);
    const { network, payTo, method, resourceUrl } = entry.key;
    const key = [network, payTo, method, resourceUrl];
    return inTransaction(this.pool, async (client) => {
      const fresh = mergeCatalogEntry(undefined, entry).merged;
      const inserted = await client.query(
        `INSERT INTO catalog (network, pay_to, method, resource_url, key_version, ledger, resource,
           type, extension_keys)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (network, pay_to, method, resource_url) DO NOTHING
         RETURNING seq`,
        [...key, fresh.keyVersion, fresh.ledger, ...resourceColumns(fresh.resource)],
      );
      if (inserted.rowCount === 1) return "inserted";
      // The conflict waited for any concurrent insert to commit, so this statement sees the row.
      const { rows } = await client.query<{
        key_version: number;
        ledger: string;
        resource: DiscoveryResource;
      }>(
        `SELECT key_version, ledger, resource FROM catalog WHERE ${CATALOG_KEY_WHERE} FOR UPDATE`,
        key,
      );
      const row = rows[0]!;
      const stored: CatalogEntry = {
        key: entry.key,
        keyVersion: row.key_version,
        ledger: Number(row.ledger),
        resource: row.resource,
      };
      const { merged, stale } = mergeCatalogEntry(stored, entry);
      // `seq` is untouched, so the entry keeps its place in the listing.
      await client.query(
        `UPDATE catalog SET key_version = $5, ledger = $6, resource = $7, type = $8,
           extension_keys = $9
         WHERE ${CATALOG_KEY_WHERE}`,
        [...key, merged.keyVersion, merged.ledger, ...resourceColumns(merged.resource)],
      );
      return stale ? "stale" : "updated";
    });
  }

  /**
   * `total` is a separate count, so it stays right for an offset past the end, where a window
   * count would return no row. The filter is written out twice rather than shared through a CTE,
   * which PostgreSQL would materialize in full for its two readers; this way the count and the
   * page each scan an index (measured on 18.3 at 100 000 entries: 14–25 ms with the CTE, 3–10 ms
   * without). They read only the narrow columns; `resource` is read for the page's rows alone, so
   * padded listings can't make a query costly.
   */
  async list(query: CatalogQuery): Promise<CatalogPage> {
    const { type, payTo, network, extensions, limit, offset } = query;
    const matches = `catalog
         WHERE ($1::text IS NULL OR type = $1)
           AND ($2::text IS NULL OR pay_to = $2)
           AND ($3::text IS NULL OR network = $3)
           AND ($4::text IS NULL OR extension_keys @> ARRAY[$4::text])`;
    const { rows } = await this.listPool.query<{ total: string; items: DiscoveryResource[] }>(
      `SELECT (SELECT count(*) FROM ${matches}) AS total,
              coalesce((SELECT jsonb_agg(c.resource ORDER BY c.seq)
                        FROM (SELECT seq FROM ${matches} ORDER BY seq LIMIT $5 OFFSET $6) p
                        JOIN catalog c USING (seq)),
                       '[]') AS items`,
      [type ?? null, payTo ?? null, network ?? null, extensions ?? null, limit, offset],
    );
    const page = rows[0]!;
    return { items: page.items, total: Number(page.total) };
  }
}

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly prunePool: pg.Pool = pool,
  ) {}

  /** A hit from an older window counts in the stored one, which `GREATEST` keeps. */
  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const resetAt = windowEnd(now, windowMs);
    const { rows } = await this.pool.query<{ count: number; reset_at: string }>(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at >= EXCLUDED.reset_at
                      THEN rate_limits.count + 1 ELSE 1 END,
         reset_at = GREATEST(rate_limits.reset_at, EXCLUDED.reset_at)
       RETURNING count, reset_at`,
      [key, resetAt],
    );
    const row = rows[0]!;
    return { count: row.count, resetAt: Number(row.reset_at) };
  }

  /**
   * No index on `reset_at`: one would turn the window-crossing `hit` updates into non-HOT ones,
   * and the scan this costs the pruner instead stays off the request path (0050, E5 and E11).
   * A key a concurrent `hit` moved into a new window fails the locked re-check and stays.
   */
  async prune(before: number, limit: number): Promise<number> {
    const { rowCount } = await this.prunePool.query(
      `DELETE FROM rate_limits WHERE key IN (
         SELECT key FROM rate_limits WHERE reset_at < $1 LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [before, limit],
    );
    return rowCount ?? 0;
  }
}

/**
 * How long `reserve` waits on a lock. A reservation holds the global scope's lock for a few round
 * trips, so a longer wait means a queue; giving up returns the connection to `reservePool`.
 */
const RESERVE_LOCK_TIMEOUT = "2s";

/**
 * Stroops reserved or spent in one scope after `$2`, as text; `reserve` and `used` share it. A
 * range scan of `spend_reservation_scopes_window` that reads the window's rows only, however many
 * the scope has had, and never `spend_reservations`. It is index-only where the visibility map
 * marks a page all-visible; pages that commits and prunes changed since the last vacuum are still
 * read from `spend_reservation_scopes`.
 */
const WINDOW_SUM = `SELECT coalesce(sum(amount), 0)::text AS used
  FROM spend_reservation_scopes WHERE scope = $1 AND at > $2`;

/** Thrown inside `reserve`'s transaction so a breach rolls the reservation back. */
class LimitExceeded extends Error {
  constructor(readonly scope: SpendScope) {
    super("spend limit exceeded");
  }
}

export class PostgresSpendStore implements SpendStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reservePool: pg.Pool = pool,
  ) {}

  /**
   * One transaction: insert the reservation (a repeated id is a no-op), create and lock the scope
   * rows in sorted order so two reservations can't deadlock, then sum each limit's window in a
   * statement of its own, which sees every reservation committed before the locks were granted.
   * A wait on any
   * lock longer than `RESERVE_LOCK_TIMEOUT` rejects with `55P03` and reserves nothing.
   */
  async reserve({ id, amount, limits, now }: SpendReservation): Promise<ReserveResult> {
    assertStroops(amount, "amount");
    for (const limit of limits) assertStroops(limit.maxStroops, "maxStroops");
    const scopes = [...new Set(limits.map((limit) => limit.scope))].sort();
    try {
      return await inTransaction<ReserveResult>(this.reservePool, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${RESERVE_LOCK_TIMEOUT}'`);
        const fresh = await client.query(
          "INSERT INTO spend_reservations (id, amount, at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
          [id, amount.toString(), now],
        );
        if (fresh.rowCount === 0) return { reserved: true };
        await client.query(
          `INSERT INTO spend_scopes (scope)
           SELECT scope FROM unnest($1::text[]) AS s (scope) ORDER BY scope
           ON CONFLICT DO NOTHING`,
          [scopes],
        );
        await client.query(
          "SELECT scope FROM spend_scopes WHERE scope = ANY ($1::text[]) ORDER BY scope FOR UPDATE",
          [scopes],
        );
        // One statement per limit: with the scope as a plain parameter the planner sees how many
        // rows it has and joins them in one pass, where a join over `unnest` probed the
        // reservations one row at a time, about 6 times slower at 100 000 rows (0022 decision 22).
        for (const limit of limits) {
          const { rows } = await client.query<{ used: string }>(WINDOW_SUM, [
            limit.scope,
            now - limit.windowMs,
          ]);
          if (BigInt(rows[0]!.used) + amount > limit.maxStroops)
            throw new LimitExceeded(limit.scope);
        }
        await client.query(
          `INSERT INTO spend_reservation_scopes (id, scope, at, amount)
           SELECT $1, unnest($2::text[]), $3, $4`,
          [id, scopes, now, amount.toString()],
        );
        return { reserved: true };
      });
    } catch (error) {
      if (error instanceof LimitExceeded) return { reserved: false, scope: error.scope };
      throw error;
    }
  }

  /** One statement, so the scope rows' copy of the amount never differs from the reservation's. */
  async commit(id: string, feeCharged: bigint): Promise<boolean> {
    assertStroops(feeCharged, "feeCharged");
    const { rows } = await this.pool.query<{ matched: boolean }>(
      `WITH r AS (
         UPDATE spend_reservations SET amount = $2, state = 'committed' WHERE id = $1 RETURNING id
       ), s AS (
         UPDATE spend_reservation_scopes rs SET amount = $2 FROM r WHERE rs.id = r.id
       )
       SELECT EXISTS (SELECT 1 FROM r) AS matched`,
      [id, feeCharged.toString()],
    );
    return rows[0]!.matched;
  }

  /** The delete cascades to the reservation's scopes. */
  async release(id: string): Promise<void> {
    await this.pool.query("DELETE FROM spend_reservations WHERE id = $1 AND state = 'reserved'", [
      id,
    ]);
  }

  async used(scope: SpendScope, windowMs: number, now: number): Promise<bigint> {
    const { rows } = await this.pool.query<{ used: string }>(WINDOW_SUM, [scope, now - windowMs]);
    return BigInt(rows[0]!.used);
  }

  /**
   * Oldest first on `spend_reservations_at`; the scope rows go with the cascade. Takes no scope
   * lock, so it never queues behind `reserve`, and skips a reservation a commit or release holds.
   */
  async prune(before: number, limit: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM spend_reservations WHERE id IN (
         SELECT id FROM spend_reservations WHERE at < $1 ORDER BY at LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [before, limit],
    );
    return rowCount ?? 0;
  }

  async recordFailure(scope: SpendScope): Promise<number> {
    const { rows } = await this.pool.query<{ failures: number }>(
      `INSERT INTO spend_scopes (scope, failures) VALUES ($1, 1)
       ON CONFLICT (scope) DO UPDATE SET failures = spend_scopes.failures + 1
       RETURNING failures`,
      [scope],
    );
    return rows[0]!.failures;
  }

  /**
   * Writes only when there are failures to reset, so the usual call, with none, doesn't queue on
   * a row `reserve` holds `FOR UPDATE` while keeping a main-pool connection.
   */
  async recordSuccess(scope: SpendScope): Promise<void> {
    await this.pool.query(
      "UPDATE spend_scopes SET failures = 0 WHERE scope = $1 AND failures <> 0",
      [scope],
    );
  }

  async openBreaker(scope: SpendScope, until: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO spend_scopes (scope, breaker_until) VALUES ($1, $2)
       ON CONFLICT (scope) DO UPDATE
         SET breaker_until = GREATEST(spend_scopes.breaker_until, EXCLUDED.breaker_until)`,
      [scope, until],
    );
  }

  async breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined> {
    const { rows } = await this.pool.query<{ breaker_until: string }>(
      "SELECT breaker_until FROM spend_scopes WHERE scope = $1 AND breaker_until > $2",
      [scope, now],
    );
    return rows[0] ? Number(rows[0].breaker_until) : undefined;
  }
}
