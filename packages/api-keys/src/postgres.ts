import type pg from "pg";
import type { AccountPlanRecord, AccountPlanStore, AccountUsageReader } from "./plans.js";
import { assertApiKey, assertApiKeyOwner, assertSealedKey } from "./rules.js";
import type { ApiKeyRecord, ApiKeyStore, OwnerKeys, SealedKeyStore } from "./store.js";

/** What a store runs its statements on: a pool, or one client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

interface ApiKeyRow {
  key_hash: string;
  owner: string;
  state: ApiKeyRecord["state"];
  created_at: string;
  revoked_at: string | null;
}

/**
 * The registry on PostgreSQL, in the table the facilitator's migration `0013_api_keys` makes.
 * `ownerOf` reads on `readPool`, the rest on `pool`: the facilitator gives the lookup it makes
 * before it lets a request in a pool of its own (0105 decision 18).
 */
export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(
    private readonly readPool: Queryable,
    private readonly pool: Queryable = readPool,
  ) {}

  async ownerOf(hash: string): Promise<string | undefined> {
    const { rows } = await this.readPool.query<{ owner: string }>(
      "SELECT owner FROM api_keys WHERE key_hash = $1 AND state = 'active'",
      [hash],
    );
    return rows[0]?.owner;
  }

  /**
   * One statement: the partial unique index decides between two concurrent issues for one owner,
   * and the loser inserts nothing. A hash already there violates the primary key instead, which
   * `ON CONFLICT` doesn't name, so it throws.
   */
  async issue({
    hash,
    owner,
    now,
  }: {
    hash: string;
    owner: string;
    now: number;
  }): Promise<boolean> {
    assertApiKey(hash, owner);
    const { rowCount } = await this.pool.query(
      `INSERT INTO api_keys (key_hash, owner, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (owner) WHERE state = 'active' DO NOTHING`,
      [hash, owner, now],
    );
    return rowCount === 1;
  }

  async revoke(owner: string, now: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE api_keys SET state = 'revoked', revoked_at = $2
       WHERE owner = $1 AND state = 'active'`,
      [owner, now],
    );
    return rowCount === 1;
  }

  async list(): Promise<ApiKeyRecord[]> {
    const { rows } = await this.pool.query<ApiKeyRow>(
      `SELECT key_hash, owner, state, created_at, revoked_at FROM api_keys
       ORDER BY created_at, key_hash`,
    );
    return rows.map((row) => ({
      hash: row.key_hash,
      owner: row.owner,
      state: row.state,
      createdAt: Number(row.created_at),
      ...(row.revoked_at !== null && { revokedAt: Number(row.revoked_at) }),
    }));
  }
}

/**
 * Account plans on PostgreSQL, in the table the facilitator's migration `0017_account_plans`
 * makes. `planOf` reads that table alone, so the portal's role needs only `SELECT` on it.
 */
export class PostgresAccountPlanStore implements AccountPlanStore {
  constructor(private readonly pool: Queryable) {}

  async planOf(owner: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ plan: string }>(
      "SELECT plan FROM account_plans WHERE owner = $1",
      [owner],
    );
    return rows[0]?.plan;
  }

  async setPlan({
    owner,
    plan,
    now,
    setBy,
    note,
  }: {
    owner: string;
    plan: string;
    now: number;
    setBy: string;
    note?: string;
  }): Promise<void> {
    assertApiKeyOwner(owner);
    await this.pool.query(
      `INSERT INTO account_plans (owner, plan, set_at, set_by, note) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner) DO UPDATE SET plan = excluded.plan, set_at = excluded.set_at,
         set_by = excluded.set_by, note = excluded.note`,
      [owner, plan, now, setBy, note ?? null],
    );
  }

  async listPlans(): Promise<AccountPlanRecord[]> {
    // Byte order, as the in-memory store's: the database's collation would order `:` and `_`
    // by other rules.
    const { rows } = await this.pool.query<{
      owner: string;
      plan: string;
      set_at: string;
      set_by: string;
      note: string | null;
    }>('SELECT owner, plan, set_at, set_by, note FROM account_plans ORDER BY owner COLLATE "C"');
    return rows.map((row) => ({
      owner: row.owner,
      plan: row.plan,
      setAt: Number(row.set_at),
      setBy: row.set_by,
      ...(row.note !== null && { note: row.note }),
    }));
  }
}

/**
 * Accounts' payments on PostgreSQL, through the view `account_usage` the facilitator's migration
 * `0017_account_plans` makes over the spend store's scope rows. It reads the view alone, so the
 * portal's role needs only `SELECT` on it.
 */
export class PostgresAccountUsageReader implements AccountUsageReader {
  constructor(private readonly pool: Queryable) {}

  async paymentsSince(owner: string, since: number): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM account_usage WHERE owner = $1 AND at >= $2",
      [owner, since],
    );
    return Number(rows[0]!.count);
  }
}

/**
 * {@link SealedKeyStore} on PostgreSQL: the registry's table and `api_key_copies`, which the
 * facilitator's migration `0014_api_key_copies` makes. A write runs in one transaction, and its
 * registry half is {@link PostgresApiKeyStore}'s own statement, so the registry's rules stay in
 * one place.
 */
export class PostgresSealedKeyStore implements SealedKeyStore {
  constructor(private readonly pool: pg.Pool) {}

  async issue({
    hash,
    owner,
    sealed,
    now,
  }: {
    hash: string;
    owner: string;
    sealed: Buffer;
    now: number;
  }): Promise<boolean> {
    assertApiKey(hash, owner);
    assertSealedKey(sealed);
    return this.transaction(async (client) => {
      if (!(await new PostgresApiKeyStore(client).issue({ hash, owner, now }))) return false;
      await client.query("INSERT INTO api_key_copies (key_hash, sealed) VALUES ($1, $2)", [
        hash,
        sealed,
      ]);
      return true;
    });
  }

  async revoke(owner: string, now: number): Promise<boolean> {
    return this.transaction(async (client) => {
      const revoked = await new PostgresApiKeyStore(client).revoke(owner, now);
      // The copy of every revoked key of the owner, not this one's alone: a key the operator's
      // script revoked left its copy behind, and this is where it goes. Never an active key's: in
      // READ COMMITTED this statement sees an issue that committed after the UPDATE above, whose
      // fresh copy would go, leaving its key active and unshowable. Such an issue finds no lock
      // when the UPDATE revoked nothing (0106 decision 34).
      await client.query(
        `DELETE FROM api_key_copies
         WHERE key_hash IN (SELECT key_hash FROM api_keys WHERE owner = $1 AND state = 'revoked')`,
        [owner],
      );
      return revoked;
    });
  }

  async keysOf(owner: string): Promise<OwnerKeys> {
    const { rows } = await this.pool.query<{
      key_hash: string;
      state: ApiKeyRecord["state"];
      created_at: string;
      revoked_at: string | null;
      sealed: Buffer | null;
    }>(
      `SELECT k.key_hash, k.state, k.created_at, k.revoked_at, c.sealed
       FROM api_keys k LEFT JOIN api_key_copies c ON c.key_hash = k.key_hash AND k.state = 'active'
       WHERE k.owner = $1`,
      [owner],
    );
    const keys: OwnerKeys = {};
    for (const row of rows) {
      if (row.state === "active") {
        keys.active = {
          hash: row.key_hash,
          createdAt: Number(row.created_at),
          ...(row.sealed !== null && { sealed: row.sealed }),
        };
      } else {
        keys.lastRevokedAt = Math.max(keys.lastRevokedAt ?? 0, Number(row.revoked_at));
      }
    }
    return keys;
  }

  /** Runs `work` on one client between BEGIN and COMMIT, or rolls back what it did and rethrows. */
  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A connection that is gone can't roll back; its transaction ended with it.
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
