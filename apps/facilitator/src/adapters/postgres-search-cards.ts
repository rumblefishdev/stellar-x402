import { searchFields } from "@stellar-x402/bazaar";
import type pg from "pg";
import type { CardListing, SearchCardStore } from "../ports/index.js";

export class PostgresSearchCardStore implements SearchCardStore {
  constructor(private readonly pool: pg.Pool) {}

  async listings(after: string, limit: number): Promise<CardListing[]> {
    const { rows } = await this.pool.query<CardListing>(
      `SELECT seq, resource FROM catalog WHERE seq > $1 ORDER BY seq LIMIT $2`,
      [after, limit],
    );
    return rows;
  }

  /**
   * `FOR SHARE` waits for a catalog write of the listing under way and then re-reads the row, so
   * a listing changed meanwhile writes no card; one this write holds waits for it, and then writes
   * its own card over this one.
   */
  async write(listing: CardListing): Promise<boolean> {
    const fields = searchFields(listing.resource);
    const { rowCount } = await this.pool.query(
      `WITH listing AS (
         SELECT seq FROM catalog WHERE seq = $1 AND resource = $2::jsonb FOR SHARE)
       INSERT INTO catalog_search (seq, name, tags, description, parameters)
       SELECT seq, $3, $4, $5, $6 FROM listing
       ON CONFLICT (seq) DO UPDATE SET name = $3, tags = $4, description = $5, parameters = $6`,
      [
        listing.seq,
        JSON.stringify(listing.resource),
        fields.name,
        fields.tags,
        fields.description,
        fields.parameters,
      ],
    );
    return rowCount === 1;
  }
}
