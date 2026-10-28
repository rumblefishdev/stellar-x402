import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type pg from "pg";
import type {
  CatalogEntry,
  CatalogPage,
  CatalogQuery,
  CatalogStore,
  UpsertOutcome,
} from "../ports/index.js";
import { inTransaction } from "./postgres.js";
import { assertLedger, extensionKeys, mergeCatalogEntry } from "./rules.js";

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
