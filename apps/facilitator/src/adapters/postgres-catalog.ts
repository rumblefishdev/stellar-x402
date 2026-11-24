import { searchFields } from "@stellar-x402/bazaar";
import type { StellarNetwork } from "@stellar-x402/config";
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
  CatalogSearch,
  CatalogSearchHit,
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
   * the row it then finds, so of concurrent writes the latest `checkedAt` stays. The same
   * statement writes the listing's search card (ADR 0014), so search finds what the catalog holds
   * from the moment it holds it.
   */
  async upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    if (entry.ledger !== null) assertCount(entry.ledger, "ledger");
    assertCount(entry.checkedAt, "checkedAt");
    // The one function that writes the catalog: no offer outside the upstream schema is stored.
    for (const offer of entry.resource.accepts) PaymentRequirementsV2Schema.parse(offer);
    const { network, payTo, method, resourceUrl } = entry.key;
    const card = searchFields(entry.resource);
    const values = [
      network,
      payTo,
      method,
      resourceUrl,
      entry.keyVersion,
      entry.ledger,
      entry.checkedAt,
      ...resourceColumns(entry.resource),
      card.name,
      card.tags,
      card.description,
      card.parameters,
    ];
    const inserted = await this.pool.query(
      `WITH listing AS (
         INSERT INTO catalog (network, pay_to, method, resource_url, key_version, ledger, checked_at,
           resource, type, extension_keys)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (network, pay_to, method, resource_url) DO NOTHING
         RETURNING seq)
       INSERT INTO catalog_search (seq, name, tags, description, parameters)
       SELECT seq, $11, $12, $13, $14 FROM listing`,
      values,
    );
    if (inserted.rowCount === 1) return "inserted";
    // `seq` is untouched, so the entry keeps its place in the listing. A seed's check (no ledger)
    // keeps the ledger a settlement wrote (0155).
    const updated = await this.pool.query(
      `WITH listing AS (
         UPDATE catalog SET key_version = $5, ledger = coalesce($6, ledger), checked_at = $7, resource = $8, type = $9,
           extension_keys = $10
         WHERE ${CATALOG_KEY_WHERE} AND coalesce(checked_at, 0) <= $7
         RETURNING seq)
       INSERT INTO catalog_search (seq, name, tags, description, parameters)
       SELECT seq, $11, $12, $13, $14 FROM listing
       ON CONFLICT (seq) DO UPDATE SET name = $11, tags = $12, description = $13, parameters = $14`,
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

  /**
   * The query's words are OR-ed, so a long sentence still matches a listing that holds one of
   * them, and ranked by `ts_rank_cd` with the field weights name 1.0, tags 0.67, description 0.5,
   * parameters 0.33 (ADR 0014, as 0134 measured it). Only the first 32 distinct words are looked
   * for: each costs a pass over every listing that holds it, so the cost grows with listings times
   * matching words. On 2,200 listings 330 common words took 1.1–1.2 s and the first 32 of them
   * 67 ms; on a catalog where every word matches nearly every listing, 32 took 170–620 ms at 2,200
   * and about 2 s, the discovery pool's statement timeout, at 10,000 (measured locally). The
   * longest of 0134's 40 real queries has 16 words, their median 4. The words are the listing's
   * search card's (`catalog_search`), which the upsert writes with it; a listing stored before
   * cards existed is found once the rewrite at start writes its card. The rank goes out and
   * comes back as PostgreSQL's text for the `real` it is, so the next page compares the same
   * number. Only the page's rows read `resource`, as in `list`.
   */
  async search(query: CatalogSearch): Promise<CatalogSearchHit[]> {
    const { text, type, payTo, network, limit, after } = query;
    const { rows } = await this.listPool.query<{
      rank: string;
      network: StellarNetwork;
      pay_to: string;
      method: string;
      resource_url: string;
      resource: DiscoveryResource;
    }>(
      `SELECT p.rank::text AS rank, c.network, c.pay_to, c.method, c.resource_url, c.resource
         FROM (SELECT seq, network, pay_to, method, resource_url,
                      ts_rank_cd('{0.33,0.5,0.67,1.0}', words, words_query) AS rank
                 FROM catalog
                 JOIN catalog_search USING (seq),
                      (SELECT string_agg(term, ' | ' ORDER BY first)::tsquery AS words_query
                         FROM (SELECT term, min(n) AS first
                                 FROM unnest(string_to_array(plainto_tsquery('english', $1)::text,
                                                             ' & ')) WITH ORDINALITY AS t(term, n)
                                GROUP BY term
                                ORDER BY first
                                LIMIT 32) terms) q
                WHERE words @@ words_query
                  AND ($2::text IS NULL OR type = $2)
                  AND ($3::text IS NULL OR pay_to = $3)
                  AND ($4::text IS NULL OR network = $4)) p
         JOIN catalog c USING (seq)
        WHERE $5::real IS NULL
           OR p.rank < $5::real
           OR (p.rank = $5::real
               AND (p.network, p.pay_to, p.method, p.resource_url) > ($6, $7, $8, $9))
        ORDER BY p.rank DESC, p.network, p.pay_to, p.method, p.resource_url
        LIMIT $10`,
      [
        text,
        type ?? null,
        payTo ?? null,
        network ?? null,
        after?.rank ?? null,
        after?.key.network ?? null,
        after?.key.payTo ?? null,
        after?.key.method ?? null,
        after?.key.resourceUrl ?? null,
        limit,
      ],
    );
    return rows.map((row) => ({
      rank: row.rank,
      key: {
        network: row.network,
        payTo: row.pay_to,
        method: row.method,
        resourceUrl: row.resource_url,
      },
      resource: row.resource,
    }));
  }
}

/**
 * A NUL inside a payer's or seller's text is valid JSON, but neither `text` nor `jsonb` stores it,
 * so the attempt's insert would fail: it is kept as U+FFFD instead.
 */
const withoutNul = (_key: string, value: unknown) =>
  typeof value === "string" ? value.replaceAll("\u0000", "\uFFFD") : value;

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
        attempt.payer ?? null,
        attempt.transaction ?? null,
        attempt.stage,
        attempt.outcome,
        attempt.reason ?? null,
        attempt.detail ?? null,
        attempt.fieldBytes ?? null,
        attempt.contentHash ?? null,
        attempt.copy === undefined ? null : JSON.stringify(attempt.copy, withoutNul),
        attempt.answer === undefined ? null : JSON.stringify(attempt.answer, withoutNul),
      ].map((value) => (typeof value === "string" ? value.replaceAll("\u0000", "\uFFFD") : value)),
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
