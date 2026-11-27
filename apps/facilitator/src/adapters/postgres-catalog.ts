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
  ListedResource,
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

/** The payments that raise a listing are those of the last 30 days (ADR 0014, quality score). */
const PAYERS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hosts that tunnel to a seller's own machine, so the listing may vanish when it sleeps (ADR 0014):
 * a host is one of them or a name under one of them.
 */
const TUNNEL_HOSTS = [
  "trycloudflare.com",
  "ts.net",
  "serveo.net",
  "serveousercontent.com",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok-free.dev",
  "loca.lt",
  "lhr.life",
  "lhr.rocks",
  "pinggy.link",
  "pinggy-free.link",
];

export class PostgresCatalogStore implements CatalogStore {
  /** `searchModel`: the model the cards' vectors are of, and the query's (`SEARCH_MODEL_ID`). */
  constructor(
    private readonly pool: pg.Pool,
    private readonly listPool: pg.Pool,
    readonly searchModel: string,
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
      card.host,
    ];
    const inserted = await this.pool.query(
      `WITH listing AS (
         INSERT INTO catalog (network, pay_to, method, resource_url, key_version, ledger, checked_at,
           resource, type, extension_keys)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (network, pay_to, method, resource_url) DO NOTHING
         RETURNING seq)
       INSERT INTO catalog_search (seq, name, tags, description, parameters, host)
       SELECT seq, $11, $12, $13, $14, $15 FROM listing`,
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
       INSERT INTO catalog_search (seq, name, tags, description, parameters, host)
       SELECT seq, $11, $12, $13, $14, $15 FROM listing
       ON CONFLICT (seq) DO UPDATE SET name = $11, tags = $12, description = $13, parameters = $14,
         host = $15`,
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
    const { rows } = await this.listPool.query<{ total: string; items: StoredListing[] }>(
      `SELECT (SELECT count(*) FROM ${matches}) AS total,
              coalesce((SELECT jsonb_agg(jsonb_build_object('key', jsonb_build_object(
                                 'network', c.network, 'payTo', c.pay_to, 'resourceUrl', c.resource_url),
                               'resource', c.resource) ORDER BY c.seq)
                        FROM (SELECT seq FROM ${matches} ORDER BY seq LIMIT $5 OFFSET $6) p
                        JOIN catalog c USING (seq)),
                       '[]') AS items`,
      [type ?? null, payTo ?? null, network ?? null, extensions ?? null, limit, offset],
    );
    const page = rows[0]!;
    return { items: await this.withCuration(page.items), total: Number(page.total) };
  }

  /**
   * The query's words are OR-ed, so a long sentence still matches a listing that holds one of
   * them, and ranked by `ts_rank_cd` with the field weights name 1.0, tags 0.67, description 0.5,
   * parameters 0.33 (ADR 0014, as 0134 measured it). Only the first 32 distinct words are looked
   * for: each costs a pass over every listing that holds it, so the cost grows with listings times
   * matching words. On 2,200 listings 330 common words took 1.1–1.2 s and the first 32 of them
   * 67 ms. On 39,578 real listings (CDP's Bazaar) the 32 most common words match 39,170 of them
   * and take 1.8–2.2 s, the discovery pool's statement timeout; ranking the matches is most of it
   * (measured locally). The
   * longest of 0134's 40 real queries has 16 words, their median 4. The words are the listing's
   * search card's (`catalog_search`), which the upsert writes with it; a listing stored before
   * cards existed is found once the rewrite at start writes its card. The rank goes out and
   * comes back as PostgreSQL's text for the `real` it is, so the next page compares the same
   * number; that text holds every digit while `extra_float_digits` is at least 1, the default
   * since PostgreSQL 12. Only the page's rows read the whole `resource`, as in `list`; each match
   * reads its `accepts`.
   *
   * The rank is the words' rank times the listing's quality factor q (ADR 0014), counted here from
   * the stored settlements: 1 + 0.2 × p / (p + 2), where p is the distinct wallets that paid for
   * the listing from 30 days before `now` on, its own `payTo` left out, and only on terms equal to
   * one of its offers; × 1.1 when its host's `stellar.toml` proves its `payTo` (0070), with these
   * two together at most 1.2; × 0.9 on a tunnel host; × 0.9 when the card's description holds
   * nothing but spaces. Counting after the matches are found keeps the planner from a nested loop over
   * all listings (measured: 324–392 ms at 4 words against 1.2–2.4 s for the other shapes).
   */
  async search(query: CatalogSearch, now: number): Promise<CatalogSearchHit[]> {
    if (query.meaning !== undefined) return this.searchFused(query, query.meaning, now);
    const { text, type, payTo, network, limit, after } = query;
    const { rows } = await this.listPool.query<HitRow>(
      `WITH m AS MATERIALIZED (
               SELECT seq, network, pay_to, method, resource_url, description, resource->'accepts' AS accepts, host,
                      ts_rank_cd('{0.33,0.5,0.67,1.0}', words, words_query) AS base
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
                  AND ($4::text IS NULL OR network = $4)),
       paid AS (
         SELECT m.seq, count(DISTINCT s.payer) AS payers
           FROM m
           LEFT JOIN settlements s
             ON s.network = m.network
            AND s.listing_method = m.method
            AND s.listing_url = m.resource_url
            AND s.payment_requirements->>'payTo' = m.pay_to
            AND s.state = 'success'
            AND s.created_at >= $11
            AND s.payer <> m.pay_to
            AND m.accepts @> jsonb_build_array(jsonb_build_object(
                  'scheme', s.payment_requirements->'scheme',
                  'network', s.payment_requirements->'network',
                  'payTo', s.payment_requirements->'payTo',
                  'asset', s.payment_requirements->'asset',
                  'amount', s.payment_requirements->'amount'))
          GROUP BY m.seq)
       SELECT p.rank::text AS rank, c.network, c.pay_to, c.method, c.resource_url, c.resource
         FROM (SELECT m.seq, m.network, m.pay_to, m.method, m.resource_url,
                      (m.base
                       * least(1.2, (1 + 0.2 * paid.payers / (paid.payers + 2.0))
                                    * CASE WHEN EXISTS (SELECT 1 FROM catalog_curation k
                                            WHERE k.network = m.network AND k.host = m.host
                                              AND k.pay_to = m.pay_to AND k.curated)
                              THEN 1.1 ELSE 1 END)
                       * CASE WHEN EXISTS (SELECT 1 FROM unnest($12::text[]) AS tunnel(host)
                                            WHERE m.host = tunnel.host OR m.host LIKE '%.' || tunnel.host)
                              THEN 0.9 ELSE 1 END
                       * CASE WHEN m.description !~ '\\S' THEN 0.9 ELSE 1 END)::real AS rank
                 FROM m JOIN paid USING (seq)) p
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
        now - PAYERS_WINDOW_MS,
        TUNNEL_HOSTS,
      ],
    );
    return this.hitsOf(rows);
  }

  /**
   * Each listing's resource with `curated`: whether its host's `stellar.toml` proof of its key's
   * account passed (0070), read from `catalog_curation` in one query for the page. The host is the
   * WHATWG URL parser's, as the check stores it.
   */
  private async withCuration(listings: StoredListing[]): Promise<ListedResource[]> {
    const keys = listings.map(({ key }) => ({
      network: key.network,
      host: new URL(key.resourceUrl).hostname,
      payTo: key.payTo,
    }));
    const { rows } = await this.listPool.query<{ network: string; host: string; pay_to: string }>(
      `SELECT network, host, pay_to FROM catalog_curation
        WHERE curated
          AND (network, host, pay_to) IN
              (SELECT * FROM unnest($1::text[], $2::text[], $3::text[]))`,
      [keys.map((key) => key.network), keys.map((key) => key.host), keys.map((key) => key.payTo)],
    );
    const curated = new Set(rows.map((row) => `${row.network} ${row.host} ${row.pay_to}`));
    return listings.map(({ resource }, i) => {
      const key = keys[i]!;
      return { ...resource, curated: curated.has(`${key.network} ${key.host} ${key.payTo}`) };
    });
  }

  private async hitsOf(rows: HitRow[]): Promise<CatalogSearchHit[]> {
    const hits = rows.map((row) => ({ ...hitOf(row), resource: row.resource }));
    const resources = await this.withCuration(hits);
    return hits.map((hit, i) => ({ ...hit, resource: resources[i]! }));
  }

  async waitingForVector(query: CatalogSearch): Promise<boolean> {
    const { rows } = await this.listPool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM catalog LEFT JOIN catalog_search USING (seq)
          WHERE model IS DISTINCT FROM $4
            AND ($1::text IS NULL OR type = $1)
            AND ($2::text IS NULL OR pay_to = $2)
            AND ($3::text IS NULL OR network = $3)) AS waiting`,
      [query.type ?? null, query.payTo ?? null, query.network ?? null, this.searchModel],
    );
    return rows[0]!.waiting;
  }

  /**
   * The fused ranking (ADR 0014). A listing matches when its card holds a vector of the query's
   * model with a cosine similarity of 0.60 or more to the query's (pgvector's `cosine_distance` is
   * 1 minus it); words never add one. Each match scores 4 / (20 + its rank by meaning) +
   * 1 / (20 + its rank by words among the matches), with no words term when it holds no query
   * word, the words ranked as in words alone. Ranks are positions, 1, 2, 3, with equal values in key
   * order, as 0134 measured the fusion (`matches.py`). The filters apply first,
   * so ranks count among the listings that pass. Every match is ranked, with an exact scan and no
   * vector index, and nothing is cut, so paging reaches the last one. The score goes out and comes
   * back as PostgreSQL's text for the `float8` it is, which holds every digit, as the words rank's
   * does. The score is then times the listing's quality factor q, counted as in `search`; the
   * positions are counted before it.
   */
  private async searchFused(
    query: CatalogSearch,
    meaning: number[],
    now: number,
  ): Promise<CatalogSearchHit[]> {
    const { text, type, payTo, network, limit, after } = query;
    const { rows } = await this.listPool.query<HitRow>(
      `WITH m AS MATERIALIZED (
               SELECT seq, network, pay_to, method, resource_url, description, accepts, host,
                      4 / (20 + row_number() OVER (ORDER BY similarity DESC, network, pay_to, method, resource_url))::float8
                        + CASE WHEN words_rank IS NULL THEN 0
                               ELSE 1 / (20 + row_number() OVER (ORDER BY words_rank DESC NULLS LAST, network, pay_to, method, resource_url))::float8
                          END AS base
                 FROM (SELECT seq, network, pay_to, method, resource_url, description,
                              resource->'accepts' AS accepts, host,
                              1 - public.cosine_distance(embedding, $5::public.vector) AS similarity,
                              CASE WHEN words @@ words_query
                                   THEN ts_rank_cd('{0.33,0.5,0.67,1.0}', words, words_query)
                              END AS words_rank
                         FROM catalog
                         JOIN catalog_search USING (seq),
                              (SELECT string_agg(term, ' | ' ORDER BY first)::tsquery AS words_query
                                 FROM (SELECT term, min(n) AS first
                                         FROM unnest(string_to_array(plainto_tsquery('english', $1)::text,
                                                                     ' & ')) WITH ORDINALITY AS t(term, n)
                                        GROUP BY term
                                        ORDER BY first
                                        LIMIT 32) terms) q
                        WHERE model = $6
                          AND ($2::text IS NULL OR type = $2)
                          AND ($3::text IS NULL OR pay_to = $3)
                          AND ($4::text IS NULL OR network = $4)) scored
                WHERE similarity >= 0.60),
       paid AS (
         SELECT m.seq, count(DISTINCT s.payer) AS payers
           FROM m
           LEFT JOIN settlements s
             ON s.network = m.network
            AND s.listing_method = m.method
            AND s.listing_url = m.resource_url
            AND s.payment_requirements->>'payTo' = m.pay_to
            AND s.state = 'success'
            AND s.created_at >= $13
            AND s.payer <> m.pay_to
            AND m.accepts @> jsonb_build_array(jsonb_build_object(
                  'scheme', s.payment_requirements->'scheme',
                  'network', s.payment_requirements->'network',
                  'payTo', s.payment_requirements->'payTo',
                  'asset', s.payment_requirements->'asset',
                  'amount', s.payment_requirements->'amount'))
          GROUP BY m.seq)
       SELECT p.rank::text AS rank, c.network, c.pay_to, c.method, c.resource_url, c.resource
         FROM (SELECT m.seq, m.network, m.pay_to, m.method, m.resource_url,
                      m.base
                      * least(1.2, (1 + 0.2 * paid.payers / (paid.payers + 2.0))
                                   * CASE WHEN EXISTS (SELECT 1 FROM catalog_curation k
                                            WHERE k.network = m.network AND k.host = m.host
                                              AND k.pay_to = m.pay_to AND k.curated)
                              THEN 1.1 ELSE 1 END)::float8
                      * CASE WHEN EXISTS (SELECT 1 FROM unnest($14::text[]) AS tunnel(host)
                                           WHERE m.host = tunnel.host OR m.host LIKE '%.' || tunnel.host)
                             THEN 0.9 ELSE 1 END
                      * CASE WHEN m.description !~ '\\S' THEN 0.9 ELSE 1 END AS rank
                 FROM m JOIN paid USING (seq)) p
         JOIN catalog c USING (seq)
        WHERE $7::float8 IS NULL
           OR p.rank < $7::float8
           OR (p.rank = $7::float8
               AND (p.network, p.pay_to, p.method, p.resource_url) > ($8, $9, $10, $11))
        ORDER BY p.rank DESC, p.network, p.pay_to, p.method, p.resource_url
        LIMIT $12`,
      [
        text,
        type ?? null,
        payTo ?? null,
        network ?? null,
        `[${meaning.join(",")}]`,
        this.searchModel,
        after?.rank ?? null,
        after?.key.network ?? null,
        after?.key.payTo ?? null,
        after?.key.method ?? null,
        after?.key.resourceUrl ?? null,
        limit,
        now - PAYERS_WINDOW_MS,
        TUNNEL_HOSTS,
      ],
    );
    return this.hitsOf(rows);
  }
}

/** A listing's key and its stored resource, as `withCuration` reads them. */
interface StoredListing {
  key: Pick<CatalogKey, "network" | "payTo" | "resourceUrl">;
  resource: DiscoveryResource;
}

/** A search result as both rankings' queries return it. */
interface HitRow {
  rank: string;
  network: StellarNetwork;
  pay_to: string;
  method: string;
  resource_url: string;
  resource: DiscoveryResource;
}

const hitOf = (row: HitRow): Omit<CatalogSearchHit, "resource"> => ({
  rank: row.rank,
  key: {
    network: row.network,
    payTo: row.pay_to,
    method: row.method,
    resourceUrl: row.resource_url,
  },
});

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
