import { searchFields } from "@stellar-x402/bazaar";
import type pg from "pg";
import type { CardListing, CatalogKey, SearchCard, SearchCardStore } from "../ports/index.js";

export class PostgresSearchCardStore implements SearchCardStore {
  /** `searchModel`: the model the cards' vectors are of (`SEARCH_MODEL_ID`). */
  constructor(
    private readonly pool: pg.Pool,
    private readonly searchModel: string,
  ) {}

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
   * its own card over this one. A card whose text is already this one is not written again: on
   * CDP's 39,577 listings that cut a restart's WAL from 48 MiB to 15 MiB. A card written anew
   * keeps its vector, which no longer counts: its text's hash changed (ADR 0014).
   */
  async write(listing: CardListing): Promise<boolean> {
    const fields = searchFields(listing.resource);
    const { rowCount } = await this.pool.query(
      `WITH listing AS (
         SELECT seq FROM catalog WHERE seq = $1 AND resource = $2::jsonb FOR SHARE)
       INSERT INTO catalog_search (seq, name, tags, description, parameters)
       SELECT seq, $3, $4, $5, $6 FROM listing
       ON CONFLICT (seq) DO UPDATE SET name = $3, tags = $4, description = $5, parameters = $6
       WHERE (catalog_search.name, catalog_search.tags, catalog_search.description,
              catalog_search.parameters) IS DISTINCT FROM ($3, $4, $5, $6)`,
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

  async cards(after: string, limit: number): Promise<SearchCard[]> {
    const { rows } = await this.pool.query<SearchCard>(
      `SELECT seq, name, tags, description, parameters, model
         FROM catalog_search WHERE seq > $1 AND model IS DISTINCT FROM $3 ORDER BY seq LIMIT $2`,
      [after, limit, this.searchModel],
    );
    return rows;
  }

  async card(key: CatalogKey): Promise<SearchCard | undefined> {
    const { rows } = await this.pool.query<SearchCard>(
      `SELECT s.seq, s.name, s.tags, s.description, s.parameters, s.model
         FROM catalog c JOIN catalog_search s USING (seq)
        WHERE c.network = $1 AND c.pay_to = $2 AND c.method = $3 AND c.resource_url = $4`,
      [key.network, key.payTo, key.method, key.resourceUrl],
    );
    return rows[0];
  }

  /**
   * The model takes its time without a lock held (ADR 0014), so the catalog may write the
   * listing's card meanwhile. The update then waits for that write and re-reads the card: a card
   * whose fields are no longer the ones embedded keeps what it holds, and the next pass embeds
   * its new text. pgvector reads a vector from its text form, `[1,2,3]`.
   */
  async writeVector(card: SearchCard, vector: number[]): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE catalog_search
          SET embedded_model = $2, embedding = $3::public.vector, embedded_hash = text_hash
        WHERE seq = $1 AND (name, tags, description, parameters) = ($4, $5, $6, $7)`,
      [
        card.seq,
        this.searchModel,
        `[${vector.join(",")}]`,
        card.name,
        card.tags,
        card.description,
        card.parameters,
      ],
    );
    return rowCount === 1;
  }
}
