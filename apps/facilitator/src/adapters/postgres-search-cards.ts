import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type pg from "pg";
import type { SearchCard, SearchCardStore, StaleListing } from "../ports/index.js";

export class PostgresSearchCardStore implements SearchCardStore {
  constructor(private readonly pool: pg.Pool) {}

  async stale(rules: number, limit: number): Promise<StaleListing[]> {
    const { rows } = await this.pool.query<{
      seq: string;
      checked_at: string | null;
      resource: DiscoveryResource;
    }>(
      `SELECT c.seq, c.checked_at, c.resource
         FROM catalog c
         LEFT JOIN catalog_search s USING (seq)
        WHERE s.seq IS NULL
           OR s.rules < $1
           OR (s.rules = $1 AND s.checked_at IS DISTINCT FROM c.checked_at)
        ORDER BY s.seq IS NULL DESC, c.seq
        LIMIT $2`,
      [rules, limit],
    );
    return rows.map((row) => ({
      seq: row.seq,
      checkedAt: row.checked_at === null ? null : Number(row.checked_at),
      resource: row.resource,
    }));
  }

  async write(card: SearchCard): Promise<boolean> {
    const { name, tags, description, parameters } = card.fields;
    const { rowCount } = await this.pool.query(
      `INSERT INTO catalog_search (seq, checked_at, rules, name, tags, description, parameters)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (seq) DO UPDATE SET checked_at = $2, rules = $3, name = $4, tags = $5,
         description = $6, parameters = $7
       WHERE catalog_search.rules <= $3`,
      [card.seq, card.checkedAt, card.rules, name, tags, description, parameters],
    );
    return rowCount === 1;
  }
}
