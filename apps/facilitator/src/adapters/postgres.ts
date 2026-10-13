import type { StellarNetwork } from "@stellar-x402/config";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import pg from "pg";
import {
  HashConflictError,
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
import { NON_FINAL_STATES, assertLedger, isFinal, isForward, mergeCatalogEntry } from "./rules.js";

/**
 * PostgreSQL adapters of the four ports (AD-7, ADR 0012), on the schema in `postgres-schema.ts`.
 * They share one pool, so concurrent calls run on separate connections.
 *
 * - Every time comes from the caller; the SQL never reads the database's clock.
 * - Every transaction runs at Read Committed, set explicitly so a role or server default can't
 *   change it. Each statement sees what committed before it started, which is why a value read
 *   after a lock wait is read in a new statement.
 * - int8 columns come back as strings: `BigInt()` for stroops, `Number()` for times, ledgers and
 *   counts. No global type parser is installed.
 */
export function postgresStores(pool: pg.Pool): Stores {
  return {
    settlements: new PostgresSettlementStore(pool),
    catalog: new PostgresCatalogStore(pool),
    rateLimits: new PostgresRateLimitStore(pool),
    spend: new PostgresSpendStore(pool),
  };
}

/**
 * A pool with the facilitator's limits: a statement runs at most 10 s on the server and a query
 * waits at most 15 s in the client. `onError` receives errors of idle connections, which would
 * otherwise crash the process.
 */
export function createPool(
  connectionString: string,
  onError: (error: Error) => void,
  max = 10,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    statement_timeout: 10_000,
    query_timeout: 15_000,
    idle_in_transaction_session_timeout: 10_000,
    application_name: "x402-facilitator",
  });
  pool.on("error", onError);
  return pool;
}

/** Runs `fn` in one Read Committed transaction on one connection; any throw rolls it back. */
async function inTransaction<T>(
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
    paymentPayload: row.payment_payload,
    paymentRequirements: row.payment_requirements,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.channel !== null) record.channel = row.channel;
  if (row.ledger !== null) record.ledger = Number(row.ledger);
  if (row.fee_charged !== null) record.feeCharged = BigInt(row.fee_charged);
  if (row.error_reason !== null) record.errorReason = row.error_reason;
  return record;
}

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
  async addHash(key: SettlementKey, hash: string, updatedAt: number): Promise<boolean> {
    const { rows } = await this.pool.query<{
      state: string | null;
      added: boolean;
      owner: string | null;
    }>(
      `WITH rec AS (
         SELECT key, state FROM settlements WHERE key = $1 FOR UPDATE
       ), ins AS (
         INSERT INTO settlement_hashes (hash, key)
         SELECT $2, key FROM rec WHERE state IN (${NON_FINAL_SQL})
         ON CONFLICT (hash) DO NOTHING
         RETURNING key
       ), upd AS (
         UPDATE settlements s
         SET state = CASE WHEN s.state = 'claimed' THEN 'signed' ELSE s.state END,
             updated_at = $3
         FROM ins WHERE s.key = ins.key
         RETURNING s.key
       )
       SELECT (SELECT state FROM rec) AS state,
              EXISTS (SELECT 1 FROM upd) AS added,
              (SELECT key FROM settlement_hashes WHERE hash = $2) AS owner`,
      [key, hash, updatedAt],
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

  async transition(
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
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
    const { rows } = await this.pool.query<SettlementRow>(
      `UPDATE settlements SET ${sets.join(", ")} WHERE key = $1 AND state = $2 RETURNING *`,
      values,
    );
    if (!rows[0]) return undefined;
    // A separate statement: a hash subquery in the UPDATE would use its snapshot from before the
    // row lock wait.
    const hashes = await this.pool.query<{ hash: string }>(
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

const CATALOG_KEY_WHERE = "network = $1 AND pay_to = $2 AND method = $3 AND resource_url = $4";

export class PostgresCatalogStore implements CatalogStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Inserts, or locks the stored entry and applies the shared merge to it, in one transaction. */
  async upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    assertLedger(entry.ledger);
    const { network, payTo, method, resourceUrl } = entry.key;
    const key = [network, payTo, method, resourceUrl];
    return inTransaction(this.pool, async (client) => {
      const fresh = mergeCatalogEntry(undefined, entry).merged;
      const inserted = await client.query(
        `INSERT INTO catalog (network, pay_to, method, resource_url, key_version, ledger, resource)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (network, pay_to, method, resource_url) DO NOTHING
         RETURNING seq`,
        [...key, fresh.keyVersion, fresh.ledger, JSON.stringify(fresh.resource)],
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
        `UPDATE catalog SET key_version = $5, ledger = $6, resource = $7 WHERE ${CATALOG_KEY_WHERE}`,
        [...key, merged.keyVersion, merged.ledger, JSON.stringify(merged.resource)],
      );
      return stale ? "stale" : "updated";
    });
  }

  /**
   * `total` counts the matches in a CTE, so it stays right for an offset past the end, where a
   * window count would return no row.
   */
  async list(query: CatalogQuery): Promise<CatalogPage> {
    const { type, payTo, network, extensions, limit, offset } = query;
    const { rows } = await this.pool.query<{ total: string; items: DiscoveryResource[] }>(
      `WITH m AS (
         SELECT seq, resource FROM catalog
         WHERE ($1::text IS NULL OR resource->>'type' = $1)
           AND ($2::text IS NULL OR pay_to = $2)
           AND ($3::text IS NULL OR network = $3)
           AND ($4::text IS NULL OR (jsonb_typeof(resource->'extensions') = 'object'
                                     AND resource->'extensions' ? $4))
       )
       SELECT (SELECT count(*) FROM m) AS total,
              coalesce((SELECT jsonb_agg(p.resource ORDER BY p.seq)
                        FROM (SELECT seq, resource FROM m ORDER BY seq LIMIT $5 OFFSET $6) p),
                       '[]') AS items`,
      [type ?? null, payTo ?? null, network ?? null, extensions ?? null, limit, offset],
    );
    const page = rows[0]!;
    return { items: page.items, total: Number(page.total) };
  }
}

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: pg.Pool) {}

  /** A hit from an older window counts in the stored one, which `GREATEST` keeps. */
  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
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
}

/** Thrown inside `reserve`'s transaction so a breach rolls the reservation back. */
class LimitExceeded extends Error {
  constructor(readonly scope: SpendScope) {
    super("spend limit exceeded");
  }
}

export class PostgresSpendStore implements SpendStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * One transaction: insert the reservation (a repeated id is a no-op), create and lock the scope
   * rows in sorted order so two reservations can't deadlock, then sum each window in a new
   * statement, which sees every reservation committed before the locks were granted.
   */
  async reserve({ id, amount, limits, now }: SpendReservation): Promise<ReserveResult> {
    const scopes = [...new Set(limits.map((limit) => limit.scope))].sort();
    try {
      return await inTransaction<ReserveResult>(this.pool, async (client) => {
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
        const { rows } = await client.query<{ used: string }>(
          `SELECT w.used
           FROM unnest($1::text[], $2::bigint[]) WITH ORDINALITY AS l (scope, since, ord)
           CROSS JOIN LATERAL (
             SELECT coalesce(sum(r.amount), 0)::text AS used
             FROM spend_reservation_scopes rs JOIN spend_reservations r ON r.id = rs.id
             WHERE rs.scope = l.scope AND r.at > l.since AND r.at <= $3
           ) w
           ORDER BY l.ord`,
          [limits.map((limit) => limit.scope), limits.map((limit) => now - limit.windowMs), now],
        );
        for (const [i, limit] of limits.entries())
          if (BigInt(rows[i]!.used) + amount > limit.maxStroops)
            throw new LimitExceeded(limit.scope);
        await client.query(
          "INSERT INTO spend_reservation_scopes (id, scope) SELECT $1, unnest($2::text[])",
          [id, scopes],
        );
        return { reserved: true };
      });
    } catch (error) {
      if (error instanceof LimitExceeded) return { reserved: false, scope: error.scope };
      throw error;
    }
  }

  async commit(id: string, feeCharged: bigint, now: number): Promise<void> {
    await this.pool.query("UPDATE spend_reservations SET amount = $2, at = $3 WHERE id = $1", [
      id,
      feeCharged.toString(),
      now,
    ]);
  }

  /** The delete cascades to the reservation's scopes. */
  async release(id: string): Promise<void> {
    await this.pool.query("DELETE FROM spend_reservations WHERE id = $1", [id]);
  }

  async used(scope: SpendScope, windowMs: number, now: number): Promise<bigint> {
    const { rows } = await this.pool.query<{ used: string }>(
      `SELECT coalesce(sum(r.amount), 0)::text AS used
       FROM spend_reservation_scopes rs JOIN spend_reservations r ON r.id = rs.id
       WHERE rs.scope = $1 AND r.at > $2 AND r.at <= $3`,
      [scope, now - windowMs, now],
    );
    return BigInt(rows[0]!.used);
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

  async recordSuccess(scope: SpendScope): Promise<void> {
    await this.pool.query("UPDATE spend_scopes SET failures = 0 WHERE scope = $1", [scope]);
  }

  async openBreaker(scope: SpendScope, until: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO spend_scopes (scope, breaker_until) VALUES ($1, $2)
       ON CONFLICT (scope) DO UPDATE SET breaker_until = EXCLUDED.breaker_until`,
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
