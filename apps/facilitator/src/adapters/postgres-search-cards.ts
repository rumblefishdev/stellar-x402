import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type pg from "pg";
import type { SearchCard, SearchCardStore, StaleListing } from "../ports/index.js";

export class PostgresSearchCardStore implements SearchCardStore {
  constructor(private readonly pool: pg.Pool) {}

  async stale(rules: number, limit: number): Promise<StaleListing[]> {
    const { rows } = await this.pool.query<{ seq: string; resource: DiscoveryResource }>(
      `SELECT c.seq, c.resource
         FROM catalog c
         LEFT JOIN catalog_search s USING (seq)
        WHERE s.seq IS NULL OR s.rules <> $1
        ORDER BY c.seq
        LIMIT $2`,
      [rules, limit],
    );
    return rows;
  }

  async write(card: SearchCard): Promise<boolean> {
    const { name, tags, description, parameters } = card.fields;
    const { rowCount } = await this.pool.query(
      `INSERT INTO catalog_search (seq, rules, name, tags, description, parameters)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (seq) DO UPDATE SET rules = $2, name = $3, tags = $4, description = $5,
         parameters = $6
       WHERE catalog_search.rules <> $2`,
      [card.seq, card.rules, name, tags, description, parameters],
    );
    return rowCount === 1;
  }
}
