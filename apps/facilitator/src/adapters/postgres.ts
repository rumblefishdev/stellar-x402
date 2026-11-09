import type { StellarNetwork } from "@stellar-x402/config";
import pg from "pg";
import {
  HashConflictError,
  LeaseFencedError,
  LEASE_SKEW_MARGIN_MS,
  type AttemptBounds,
  type AttemptState,
  type AttemptUpdate,
  type ChannelLease,
  type LeaseFence,
  type ClaimResult,
  type ReopenResult,
  type NewSettlement,
  type RateLimitHit,
  type RateLimitStore,
  type ReserveResult,
  type BreakerBackoff,
  type ScopeUsage,
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
} from "../ports/index.js";
import {
  NON_FINAL_STATES,
  assertStroops,
  attemptRankSql,
  isFinal,
  isForward,
  windowEnd,
} from "./rules.js";
import { PostgresCatalogAttemptStore, PostgresCatalogStore } from "./postgres-catalog.js";

/**
 * PostgreSQL adapters of the ports (AD-7, ADR 0012), on the schema in `postgres-schema.ts`.
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
    catalogAttempts: new PostgresCatalogAttemptStore(pool),
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
  /** Absent on a database `0010_settlement_failure` hasn't reached (`SELECT s.*`). */
  failure?: SettlementRecord["failure"] | null;
  /** Absent on a database `0002_success_answered` hasn't reached (`SELECT s.*`). */
  success_answered_at?: string | null;
  /** Absent on a database `0005_settlement_attempts` hasn't reached (`SELECT s.*`). */
  version?: number;
  /** Absent on a database `0007_settlement_reopened` hasn't reached (`SELECT s.*`). */
  reopened?: number;
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
    // Without the column, nothing can reopen: as a record claimed before 0073.
    reopened: row.reopened ?? -1,
    paymentPayload: row.payment_payload,
    paymentRequirements: row.payment_requirements,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.channel !== null) record.channel = row.channel;
  if (row.ledger !== null) record.ledger = Number(row.ledger);
  if (row.fee_charged !== null) record.feeCharged = BigInt(row.fee_charged);
  if (row.error_reason !== null) record.errorReason = row.error_reason;
  if (row.failure != null) record.failure = row.failure;
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
  inner_hash: string | null;
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
  if (row.inner_hash !== null) attempt.innerHash = row.inner_hash;
  if (row.updated_at !== null) attempt.updatedAt = Number(row.updated_at);
  return attempt;
}

/**
 * Moves the named attempts of `$1` forward, each on its own, and stamps `$2`; `$3` is the updates
 * as JSON. The rank comparison drops an update that isn't ahead, so concurrent writers can only
 * move an attempt on. An update with `rewrap_of` adds its hash after the record's others, with
 * that attempt's inner hash (0087); the `UPDATE`'s snapshot doesn't see the row, so it doesn't
 * move it too. Returns one row per attempt moved or added.
 */
const MARK_ATTEMPTS = `WITH u AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb)
      AS u(hash text, state text, channel text, error_code text, rewrap_of text)
  ), added AS (
    INSERT INTO settlement_hashes (hash, key, state, channel, error_code, inner_hash, updated_at)
    SELECT u.hash, h.key, u.state, coalesce(u.channel, h.channel), u.error_code, h.inner_hash, $2
    FROM u JOIN settlement_hashes h ON h.hash = u.rewrap_of AND h.key = $1
    ON CONFLICT (hash) DO NOTHING
    RETURNING hash
  ), moved AS (
    UPDATE settlement_hashes h
    SET state = u.state,
        channel = coalesce(u.channel, h.channel),
        error_code = coalesce(u.error_code, h.error_code),
        updated_at = $2
    FROM u
    WHERE h.hash = u.hash AND h.key = $1 AND u.rewrap_of IS NULL
      AND ${attemptRankSql("u.state")} > ${attemptRankSql("h.state")}
    RETURNING h.hash
  )
  SELECT hash FROM added UNION ALL SELECT hash FROM moved`;

const attemptsJson = (updates: AttemptUpdate[]) =>
  JSON.stringify(
    updates.map(({ hash, state, channel, errorCode, rewrapOf }) => ({
      hash,
      state,
      rewrap_of: rewrapOf ?? null,
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
  failure: "failure",
} as const;

/** Rolls a claim's transaction back: `blocker` holds its payer and asset. */
class PayerBusy extends Error {
  constructor(readonly blocker: SettlementKey) {
    super("another settlement of this payer and asset is not final");
  }
}

/**
 * Takes the in-flight row of `s`'s network, payer and asset for `s.key`, within the claim's
 * transaction; resolves the key that holds it instead, if that one's record is not final.
 *
 * The first statement inserts the row, or locks the one there with a no-op update and returns its
 * latest key: a row another claim committed while this one waited, or the one left after a final
 * write deleted it (the insert then goes ahead). Its snapshot is older than that commit, so the
 * holder's record is read in a new statement, which sees it: a claim commits its record with its
 * row. A row whose record is final or missing is replaced: the release before
 * `0011_settlement_in_flight` ends records without deleting their row. While the lock is held, a
 * final write of the holder waits to delete the row, and deletes it only if it still names that
 * holder, so it never frees a row this claim took over.
 */
async function takeInFlight(
  client: pg.PoolClient,
  s: Pick<NewSettlement, "key" | "network" | "payer" | "paymentRequirements">,
): Promise<SettlementKey | undefined> {
  const where = [s.network, s.payer, s.paymentRequirements.asset];
  const { rows } = await client.query<{ key: string }>(
    `INSERT INTO settlement_in_flight (network, payer, asset, key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (network, payer, asset) DO UPDATE SET key = settlement_in_flight.key
     RETURNING key`,
    [...where, s.key],
  );
  const holder = rows[0]!.key as SettlementKey;
  if (holder === s.key) return undefined;
  const held = await client.query<{ state: SettlementState }>(
    "SELECT state FROM settlements WHERE key = $1",
    [holder],
  );
  const state = held.rows[0]?.state;
  if (state !== undefined && !isFinal(state)) return holder;
  await client.query(
    "UPDATE settlement_in_flight SET key = $4 WHERE network = $1 AND payer = $2 AND asset = $3",
    [...where, s.key],
  );
  return undefined;
}

export class PostgresSettlementStore implements SettlementStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * One transaction: the record's insert-if-absent, then its payer and asset's in-flight row. A
   * busy payer and asset rolls the insert back, so nothing is written; a concurrent claim of the
   * same key that waited on the insert then inserts it itself.
   */
  async claim(settlement: NewSettlement): Promise<ClaimResult> {
    const s = settlement;
    let claimed: SettlementRecord | undefined;
    try {
      claimed = await inTransaction(this.pool, async (client) => {
        const { rows } = await client.query<SettlementRow>(
          `INSERT INTO settlements (key, network, payer, nonce, fingerprint, state, payment_payload,
             payment_requirements, created_at, updated_at, reopened)
           VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $8, 0)
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
        if (!rows[0]) return undefined;
        const blocker = await takeInFlight(client, s);
        if (blocker !== undefined) throw new PayerBusy(blocker);
        return toRecord(rows[0], []);
      });
    } catch (error) {
      if (error instanceof PayerBusy) return { claimed: false, busy: error.blocker };
      throw error;
    }
    if (claimed) return { claimed: true, record: claimed };
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
   * One statement locks the lease row while it still carries the caller's token, then the record,
   * adds the hash while the record is non-final, and moves `claimed` to `signed`; it also returns
   * the hash's owner as its snapshot sees it. The lease's `FOR KEY SHARE` makes a takeover, which
   * changes the unique `token`, or a release wait until this commits, and one that committed
   * first is re-read, so its new token refuses the hash. A renewal changes only `expires_at`, so
   * it never waits on this (0071 decisions 7, 16).
   */
  async addHash(
    key: SettlementKey,
    hash: string,
    lease: LeaseFence,
    updatedAt: number,
    bounds?: AttemptBounds,
    claim?: number,
    innerHash?: string,
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{
      fenced: boolean;
      state: string | null;
      added: boolean;
      owner: string | null;
    }>(
      `WITH fence AS (
         SELECT name FROM leases WHERE name = $7 AND token = $8::uuid FOR KEY SHARE
       ), rec AS (
         SELECT key, state FROM settlements
         WHERE key = $1 AND ($6::integer IS NULL OR reopened = $6)
           AND EXISTS (SELECT 1 FROM fence)
         FOR UPDATE
       ), ins AS (
         INSERT INTO settlement_hashes
           (hash, key, state, max_time, max_ledger, inner_hash, updated_at)
         SELECT $2, key, 'stored', $4::bigint, $5::bigint, $9::text, $3 FROM rec
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
       SELECT NOT EXISTS (SELECT 1 FROM fence) AS fenced,
              (SELECT state FROM rec) AS state,
              EXISTS (SELECT 1 FROM upd) AS added,
              (SELECT key FROM settlement_hashes WHERE hash = $2) AS owner`,
      [
        key,
        hash,
        updatedAt,
        bounds?.maxTime ?? null,
        bounds?.maxLedger ?? null,
        claim ?? null,
        lease.name,
        lease.token,
        innerHash ?? null,
      ],
    );
    const { fenced, state, added, owner } = rows[0]!;
    // 0. Another process took the lease, or nobody holds it.
    if (fenced) throw new LeaseFencedError(lease.name);
    // 1. A missing or final record, or one reopened since the caller's claim.
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
      `SELECT hash, state, max_time, max_ledger, channel, error_code, inner_hash, updated_at
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
    claim?: number,
  ): Promise<SettlementRecord | undefined> {
    if (update.feeCharged !== undefined) assertStroops(update.feeCharged, "feeCharged");
    const { attempts } = update;
    if (attempts?.length)
      return inTransaction(this.pool, async (client) => {
        await client.query(MARK_ATTEMPTS, [key, update.updatedAt, attemptsJson(attempts)]);
        return this.moveState(client, key, expected, update, expectedVersion, claim);
      });
    return this.moveState(this.pool, key, expected, update, expectedVersion, claim);
  }

  private async moveState(
    db: pg.Pool | pg.PoolClient,
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
    expectedVersion?: number,
    claim?: number,
  ): Promise<SettlementRecord | undefined> {
    if (!isForward(expected, update.state)) return undefined;
    const values: unknown[] = [key, expected, update.state, update.updatedAt];
    const sets = ["state = $3", "updated_at = $4"];
    // A field given as `undefined` clears the column.
    for (const [field, column] of Object.entries(UPDATE_COLUMNS))
      if (field in update) {
        const value = update[field as keyof typeof UPDATE_COLUMNS];
        // The driver sends an object as JSON, but a column of a type of its own is clearer cast.
        values.push(
          typeof value === "bigint"
            ? value.toString()
            : field === "failure" && value
              ? JSON.stringify(value)
              : (value ?? null),
        );
        sets.push(`${column} = $${values.length}${field === "failure" ? "::jsonb" : ""}`);
      }
    // Re-checked on the row `addHash` committed, if it held the lock: its version is the new one.
    let where = "key = $1 AND state = $2";
    if (expectedVersion !== undefined) {
      values.push(expectedVersion);
      where += ` AND version = $${values.length}`;
    }
    if (claim !== undefined) {
      values.push(claim);
      where += ` AND reopened = $${values.length}`;
    }
    let sql = `UPDATE settlements SET ${sets.join(", ")} WHERE ${where} RETURNING *`;
    // A final record frees its payer and asset for the next claim, in the same statement. The
    // row is deleted only while it names this record: one a claim took over stays (`claim`).
    if (isFinal(update.state))
      sql = `WITH moved AS (${sql}), freed AS (
          DELETE FROM settlement_in_flight f USING moved
          WHERE f.network = moved.network AND f.payer = moved.payer
            AND f.asset = moved.payment_requirements->>'asset' AND f.key = moved.key
        )
        SELECT * FROM moved`;
    const { rows } = await db.query<SettlementRow>(sql, values);
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

  /**
   * One transaction: a conditional `UPDATE`, whose row lock lets exactly one of several callers
   * reopen it, then its payer and asset's in-flight row, as `claim` takes it. A busy payer and
   * asset rolls the `UPDATE` back, so the record stays as it was.
   */
  async reopen(
    key: SettlementKey,
    fingerprint: string,
    reasons: readonly string[],
    now: number,
  ): Promise<ReopenResult> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const { rows } = await client.query<SettlementRow>(
          `UPDATE settlements s
           SET state = 'claimed', error_reason = NULL, reopened = s.reopened + 1,
               version = s.version + 1, created_at = $4, updated_at = $4
           WHERE s.key = $1 AND s.state = 'rejected' AND s.fingerprint = $2
             AND s.error_reason = ANY ($3::text[]) AND s.reopened >= 0
             AND NOT EXISTS (SELECT 1 FROM settlement_hashes h WHERE h.key = s.key)
           RETURNING *`,
          [key, fingerprint, [...reasons], now],
        );
        if (!rows[0]) return undefined;
        const record = toRecord(rows[0], []);
        const blocker = await takeInFlight(client, record);
        if (blocker !== undefined) throw new PayerBusy(blocker);
        return record;
      });
    } catch (error) {
      if (error instanceof PayerBusy) return { busy: error.blocker };
      throw error;
    }
  }

  async listNonFinal(network: StellarNetwork): Promise<SettlementRecord[]> {
    const { rows } = await this.pool.query<SettlementRow>(
      `${SELECT_RECORD} WHERE s.network = $1 AND s.state IN (${NON_FINAL_SQL})
       ORDER BY s.created_at, s.key`,
      [network],
    );
    return rows.map((row) => toRecord(row));
  }

  /** Deletes the in-flight row only while it still names `key`, as the final-write CTE does. */
  async freeInFlight(key: SettlementKey): Promise<void> {
    await this.pool.query("DELETE FROM settlement_in_flight WHERE key = $1", [key]);
  }

  /** A row upsert, never an advisory lock: the lease must outlive any one connection. */
  async acquireLease(
    name: string,
    holder: string,
    ttlMs: number,
    now: number,
  ): Promise<ChannelLease | undefined> {
    const { rows } = await this.pool.query<{
      name: string;
      holder: string;
      expires_at: string;
      token: string;
    }>(
      // An insert takes the column's default token; a takeover or a re-acquire draws a new one.
      `INSERT INTO leases (name, holder, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE
         SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at, token = gen_random_uuid()
       WHERE leases.holder = EXCLUDED.holder OR leases.expires_at < $4
       RETURNING name, holder, expires_at, token`,
      // Another holder's lease is taken only once it expired more than the margin ago.
      [name, holder, now + ttlMs, now - LEASE_SKEW_MARGIN_MS],
    );
    const row = rows[0];
    return (
      row && {
        name: row.name,
        holder: row.holder,
        expiresAt: Number(row.expires_at),
        token: row.token,
      }
    );
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
export const RESERVE_LOCK_TIMEOUT_MS = 2_000;

/**
 * How long `recordSuccess` waits for the scope row `reserve` may hold `FOR UPDATE` before it gives
 * up (0024). A success count is best-effort: dropping one under contention only makes a wasm
 * asset's breaker a touch more eager (conservative), and waiting would hold a main-pool connection
 * and starve `claim`, `addHash` and `transition`. `recordFailure` keeps waiting: the breaker must
 * not miss a failure.
 */
export const SUCCESS_LOCK_TIMEOUT_MS = 500;

/** Postgres `lock_not_available`: a statement gave up waiting for a lock within `lock_timeout`. */
const LOCK_TIMEOUT_CODE = "55P03";

/** `$2` is `now` and `$3` the window, in `recordFailure` and `recordSuccess`: a tumbling window. */
const WINDOW_ENDED = "(s.window_start IS NULL OR $2::bigint - s.window_start > $3::bigint)";

/** The strikes an opening at `$2` builds on: none once `$6` has passed since the last opening. */
const STRIKES_NOW =
  "(CASE WHEN s.last_opened_at IS NULL OR s.last_opened_at < $2::bigint - $6::bigint THEN 0 ELSE s.strikes END)";

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
   * One transaction: insert the reservation (a repeated id is a no-op), create or lock the scope
   * rows in one statement and sorted order so two reservations can't deadlock, then sum each
   * limit's window in a statement of its own, which sees every reservation committed before the
   * locks were granted. A wait on any lock longer than `RESERVE_LOCK_TIMEOUT_MS` rejects with
   * `55P03` and reserves nothing.
   */
  async reserve({ id, amount, limits, now }: SpendReservation): Promise<ReserveResult> {
    assertStroops(amount, "amount");
    for (const limit of limits) assertStroops(limit.maxStroops, "maxStroops");
    const scopes = [...new Set(limits.map((limit) => limit.scope))].sort();
    try {
      return await inTransaction<ReserveResult>(this.reservePool, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${RESERVE_LOCK_TIMEOUT_MS}ms'`);
        const fresh = await client.query(
          "INSERT INTO spend_reservations (id, amount, at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
          [id, amount.toString(), now],
        );
        if (fresh.rowCount === 0) {
          const { rows } = await client.query<{ state: string }>(
            "SELECT state FROM spend_reservations WHERE id = $1",
            [id],
          );
          // The row was there (the insert was a no-op), yet it is gone now: a `prune` deleted it
          // between the two statements. Reserving nothing here would be a fail-open — the fee
          // ceiling would count against no budget. Reject as "try again": a retry's insert, the
          // row now absent, reserves it afresh.
          if (!rows[0]) throw new Error("reservation row vanished before its state was read");
          return rows[0].state === "released"
            ? { reserved: false, released: true }
            : { reserved: true, usage: [] };
        }
        // Creates or locks each scope row in the one statement. `ON CONFLICT DO NOTHING` took no
        // lock on a row that was there, so a prune could delete it before a separate `FOR
        // UPDATE`, which then locked nothing, and two reserves summed the window without each
        // other: one ceiling over per race. `DO UPDATE` locks the row it finds and, if a
        // concurrent delete took it, inserts it again.
        const locked = await client.query(
          `INSERT INTO spend_scopes (scope)
           SELECT scope FROM unnest($1::text[]) AS s (scope) ORDER BY scope
           ON CONFLICT (scope) DO UPDATE SET scope = EXCLUDED.scope`,
          [scopes],
        );
        if (locked.rowCount !== scopes.length) throw new Error("a spend scope row was not locked");
        // One statement per limit: with the scope as a plain parameter the planner sees how many
        // rows it has and joins them in one pass, where a join over `unnest` probed the
        // reservations one row at a time, about 6 times slower at 100 000 rows (0022 decision 22).
        const usage: ScopeUsage[] = [];
        for (const limit of limits) {
          const { rows } = await client.query<{ used: string }>(WINDOW_SUM, [
            limit.scope,
            now - limit.windowMs,
          ]);
          const usedStroops = BigInt(rows[0]!.used) + amount;
          if (usedStroops > limit.maxStroops) throw new LimitExceeded(limit.scope);
          usage.push({ scope: limit.scope, usedStroops, maxStroops: limit.maxStroops });
        }
        await client.query(
          `INSERT INTO spend_reservation_scopes (id, scope, at, amount)
           SELECT $1, unnest($2::text[]), $3, $4`,
          [id, scopes, now, amount.toString()],
        );
        return { reserved: true, usage };
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
         UPDATE spend_reservations SET amount = $2, state = 'committed'
           WHERE id = $1 AND state <> 'released' RETURNING id
       ), s AS (
         UPDATE spend_reservation_scopes rs SET amount = $2 FROM r WHERE rs.id = r.id
       )
       SELECT EXISTS (SELECT 1 FROM r) AS matched`,
      [id, feeCharged.toString()],
    );
    return rows[0]!.matched;
  }

  /**
   * Two statements in `reserve`'s order, reservation then scope rows. The second reads a snapshot
   * of its own, so it sees the scope rows of a `reserve` that committed while the first waited
   * on the same id; a single statement would not. A committed reservation keeps its scope rows.
   */
  async release(id: string, now: number): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO spend_reservations (id, amount, at, state) VALUES ($1, 0, $2, 'released')
         ON CONFLICT (id) DO UPDATE SET state = 'released', amount = 0
           WHERE spend_reservations.state = 'reserved'`,
        [id, now],
      );
      await client.query(
        `DELETE FROM spend_reservation_scopes WHERE id = $1
           AND EXISTS (SELECT 1 FROM spend_reservations WHERE id = $1 AND state = 'released')`,
        [id],
      );
    });
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

  async pruneScopes(before: number, limit: number): Promise<number> {
    // A row is quiescent when its window, its breaker and its last opening all fall before the
    // cutoff, and no reservation since then counts against it: no failure count, strike or open
    // breaker it still needs is lost, and a busy budget-only scope (`reserve` sets none of the
    // three) isn't deleted and recreated on every pass. A null means that kind of activity never
    // happened. A row a reserve holds is skipped, and `reserve` recreates a lock row it needs.
    const { rowCount } = await this.pool.query(
      `DELETE FROM spend_scopes WHERE scope IN (
         SELECT scope FROM spend_scopes s
         WHERE (window_start IS NULL OR window_start < $1)
           AND (last_opened_at IS NULL OR last_opened_at < $1)
           AND (breaker_until IS NULL OR breaker_until < $1)
           AND NOT EXISTS (
             SELECT 1 FROM spend_reservation_scopes rs WHERE rs.scope = s.scope AND rs.at >= $1)
         LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [before, limit],
    );
    return rowCount ?? 0;
  }

  async recordFailure(scope: SpendScope, now: number, windowMs: number) {
    const { rows } = await this.pool.query<{
      failures: number;
      successes: number;
      strikes: number;
      last_opened_at: string | null;
    }>(
      `INSERT INTO spend_scopes AS s (scope, failures, window_start) VALUES ($1, 1, $2::bigint)
       ON CONFLICT (scope) DO UPDATE SET
         failures = CASE WHEN ${WINDOW_ENDED} THEN 1 ELSE s.failures + 1 END,
         successes = CASE WHEN ${WINDOW_ENDED} THEN 0 ELSE s.successes END,
         window_start = CASE WHEN ${WINDOW_ENDED} THEN $2::bigint ELSE s.window_start END
       RETURNING failures, successes, strikes, last_opened_at`,
      [scope, now, windowMs],
    );
    const row = rows[0]!;
    return {
      failures: row.failures,
      successes: row.successes,
      strikes: row.strikes,
      ...(row.last_opened_at === null ? {} : { lastOpenedAt: Number(row.last_opened_at) }),
    };
  }

  /**
   * Counts in the same window as `recordFailure`, and never touches the failures of the one it ends
   * in. Best-effort under a short `lock_timeout`: it gives up rather than hold a main-pool
   * connection waiting on the scope row `reserve` locks (0024, {@link SUCCESS_LOCK_TIMEOUT_MS}).
   */
  async recordSuccess(scope: SpendScope, now: number, windowMs: number): Promise<void> {
    try {
      await inTransaction(this.pool, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${SUCCESS_LOCK_TIMEOUT_MS}ms'`);
        await client.query(
          `INSERT INTO spend_scopes AS s (scope, successes, window_start) VALUES ($1, 1, $2::bigint)
           ON CONFLICT (scope) DO UPDATE SET
             failures = CASE WHEN ${WINDOW_ENDED} THEN 0 ELSE s.failures END,
             successes = CASE WHEN ${WINDOW_ENDED} THEN 1 ELSE s.successes + 1 END,
             window_start = CASE WHEN ${WINDOW_ENDED} THEN $2::bigint ELSE s.window_start END`,
          [scope, now, windowMs],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === LOCK_TIMEOUT_CODE) return;
      throw error;
    }
  }

  /**
   * One statement, so instances opening the same breaker together add one strike: the one that
   * gets the row first writes, and the rest find it open (the `WHERE` is checked again on the
   * row it left) and read its end. An open breaker is never written, so its end is never moved
   * earlier; a closed one ended by `now`, so the new end is the later one. The step is computed
   * in floating point with the exponent capped, so a long run of strikes clamps to `maxMs`
   * instead of overflowing.
   */
  async openBreaker(scope: SpendScope, now: number, backoff: BreakerBackoff): Promise<number> {
    const params = [
      scope,
      now,
      backoff.baseMs,
      backoff.factor,
      backoff.maxMs,
      backoff.strikeResetMs,
    ];
    const { rows } = await this.pool.query<{ breaker_until: string }>(
      `INSERT INTO spend_scopes AS s (scope, breaker_until, strikes, last_opened_at)
       VALUES ($1, $2::bigint + round(LEAST($3::float8, $5::float8)), 1, $2::bigint)
       ON CONFLICT (scope) DO UPDATE SET
         breaker_until = $2::bigint + round(LEAST(
           $3::float8 * exp(LEAST(${STRIKES_NOW} * ln(GREATEST($4::float8, 1)), 50)),
           $5::float8)),
         strikes = ${STRIKES_NOW} + 1,
         last_opened_at = $2::bigint
       WHERE s.breaker_until IS NULL OR s.breaker_until <= $2::bigint
       RETURNING breaker_until`,
      params,
    );
    if (rows[0]) return Number(rows[0].breaker_until);
    const open = await this.pool.query<{ breaker_until: string }>(
      "SELECT breaker_until FROM spend_scopes WHERE scope = $1",
      [scope],
    );
    return Number(open.rows[0]!.breaker_until);
  }

  async breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined> {
    const { rows } = await this.pool.query<{ breaker_until: string }>(
      "SELECT breaker_until FROM spend_scopes WHERE scope = $1 AND breaker_until > $2",
      [scope, now],
    );
    return rows[0] ? Number(rows[0].breaker_until) : undefined;
  }

  async breakersOpen(scopes: SpendScope[], now: number): Promise<Set<SpendScope>> {
    if (scopes.length === 0) return new Set();
    const { rows } = await this.pool.query<{ scope: SpendScope }>(
      "SELECT scope FROM spend_scopes WHERE scope = ANY ($1::text[]) AND breaker_until > $2",
      [scopes, now],
    );
    return new Set(rows.map((row) => row.scope));
  }
}
