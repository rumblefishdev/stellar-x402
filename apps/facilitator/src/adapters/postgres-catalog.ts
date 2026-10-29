import { PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type pg from "pg";
import type {
  CatalogAttempt,
  CatalogAttemptStore,
  CatalogEntry,
  CatalogKey,
  CatalogPage,
  CatalogQuery,
  CatalogStore,
  UpsertOutcome,
} from "../ports/index.js";
import { assertCount, extensionKeys } from "./rules.js";

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

  async get(key: CatalogKey): Promise<DiscoveryResource | undefined> {
    const { rows } = await this.pool.query<{ resource: DiscoveryResource }>(
      `SELECT resource FROM catalog WHERE ${CATALOG_KEY_WHERE}`,
      [key.network, key.payTo, key.method, key.resourceUrl],
    );
    return rows[0]?.resource;
  }

  /**
   * Inserts, or replaces the stored entry unless a check that started later wrote it. A
   * concurrent insert of the key makes the insert wait for its commit, and the update re-reads
   * the row it then finds, so of concurrent writes the latest `checkedAt` stays.
   */
  async upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    assertCount(entry.ledger, "ledger");
    assertCount(entry.checkedAt, "checkedAt");
    // The one function that writes the catalog: no offer outside the upstream schema is stored.
    for (const offer of entry.resource.accepts) PaymentRequirementsV2Schema.parse(offer);
    const { network, payTo, method, resourceUrl } = entry.key;
    const values = [
      network,
      payTo,
      method,
      resourceUrl,
      entry.keyVersion,
      entry.ledger,
      entry.checkedAt,
      ...resourceColumns(entry.resource),
    ];
    const inserted = await this.pool.query(
      `INSERT INTO catalog (network, pay_to, method, resource_url, key_version, ledger, checked_at,
         resource, type, extension_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (network, pay_to, method, resource_url) DO NOTHING`,
      values,
    );
    if (inserted.rowCount === 1) return "inserted";
    // `seq` is untouched, so the entry keeps its place in the listing.
    const updated = await this.pool.query(
      `UPDATE catalog SET key_version = $5, ledger = $6, checked_at = $7, resource = $8, type = $9,
         extension_keys = $10
       WHERE ${CATALOG_KEY_WHERE} AND coalesce(checked_at, 0) <= $7`,
      values,
    );
    return updated.rowCount === 1 ? "updated" : "stale";
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

export class PostgresCatalogAttemptStore implements CatalogAttemptStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(attempt: CatalogAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO catalog_attempts (at, network, pay_to, method, resource_url, url, payer,
         transaction, stage, outcome, reason, detail, field_bytes, content_hash, copy, answer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        attempt.at,
        attempt.network,
        attempt.payTo,
        attempt.key?.method ?? null,
        attempt.key?.resourceUrl ?? null,
        attempt.url ?? null,
        attempt.payer,
        attempt.transaction ?? null,
        attempt.stage,
        attempt.outcome,
        attempt.reason ?? null,
        attempt.detail ?? null,
        attempt.fieldBytes ?? null,
        attempt.contentHash ?? null,
        attempt.copy === undefined ? null : JSON.stringify(attempt.copy),
        attempt.answer === undefined ? null : JSON.stringify(attempt.answer),
      ],
    );
  }

  async prune(before: number, limit: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM catalog_attempts WHERE id IN (
         SELECT id FROM catalog_attempts WHERE at < $1 LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [before, limit],
    );
    return rowCount ?? 0;
  }
}
