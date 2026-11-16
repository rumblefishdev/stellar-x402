import type pg from "pg";
import { assertApiKey } from "./rules.js";
import type { ApiKeyRecord, ApiKeyStore } from "./store.js";

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
    private readonly readPool: pg.Pool,
    private readonly pool: pg.Pool = readPool,
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
