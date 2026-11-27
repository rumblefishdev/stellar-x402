import { STELLAR_NETWORKS } from "@stellar-x402/config";
import type { SearchDiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type {
  CatalogSearch,
  CatalogSearchPosition,
  CatalogStore,
  Embedder,
} from "../ports/index.js";
import {
  CATALOGED_EXTENSIONS,
  CATALOGED_SCHEMES,
  DISCOVERY_LIMIT,
  QUERY as LIST_QUERY,
  misspelledKnown,
  text,
} from "./discovery.js";

/** The longest query served (0120): a description of a need fits, a pasted document does not. */
export const MAX_QUERY_LENGTH = 2_000;
/**
 * A cursor holds a listing's key, whose URL alone may take 2,048 characters (`LIMITS.urlChars`),
 * with a tool name of 128, an address, a network, the model's name (82 characters for granite at
 * its pinned revision) and the field names: under 3,400 characters in base64url.
 */
const MAX_CURSOR_LENGTH = 4_096;
/**
 * Seconds a client waits before it pages on with a fused cursor while search runs on words, as
 * `/settle` and `/verify` ask on their own 503s (app.ts): no measurement of how fast the model
 * comes back sets it.
 */
const SEARCH_MODEL_RETRY_AFTER_S = 5;
/**
 * A fused query this slow is logged and counted (`search-slow`): half of the discovery pool's
 * 2 s statement timeout, so the alarm comes before searches fail with a 500. The exact scan grows
 * with the catalog (ADR 0014); this is the sign to measure and index it.
 */
export const SEARCH_SLOW_MS = 1_000;
/** The parameters upstream's `search` sends: the list's filters and `limit`, a query, a cursor. */
const QUERY = LIST_QUERY.omit({ offset: true }).extend({
  query: z
    .string()
    .max(MAX_QUERY_LENGTH)
    .regex(/^\P{Cc}*$/u)
    .refine((query) => query.trim() !== ""),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});
const KNOWN_PARAMS = Object.keys(QUERY.shape);

/**
 * Inside `real`'s range, which PostgreSQL refuses to cast beyond (`1e999`, `1e-999`); `ts_rank_cd`
 * writes 0 or a value in it, with an exponent once it reaches 1e6 (`1e+06`).
 */
const RANK = z
  .string()
  .regex(/^\d+(\.\d+)?(e[-+]?\d+)?$/)
  .refine((rank) => {
    // `1e-999` reads as 0 here but is out of range for PostgreSQL, so a zero is written as one.
    const value = Number(rank);
    return /^0(\.0+)?$/.test(rank) || (value >= 1e-37 && value <= 1e37);
  });

const POSITION = {
  rank: RANK,
  key: z.object({
    network: z.enum([STELLAR_NETWORKS.testnet, STELLAR_NETWORKS.pubnet]),
    payTo: text,
    method: text,
    resourceUrl: z.string().regex(/^\P{Cc}*$/u),
  }),
};

/**
 * What the cursor carries: the last result's rank and key, and the ranking that wrote it, fused
 * with the model whose vectors it read, or words alone. A rank from another ranking or model has
 * another scale, so the route refuses its cursor (ADR 0014).
 */
const CURSOR = z.discriminatedUnion("ranking", [
  z.object({ ranking: z.literal("words"), ...POSITION }),
  z.object({ ranking: z.literal("fused"), model: text, ...POSITION }),
]);

/** How the page a cursor came from was ranked: fused, with its model, or words alone. */
interface Ranking {
  ranking: "words" | "fused";
  model?: string;
}

function readCursor(cursor: string): (CatalogSearchPosition & Ranking) | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // Not base64url JSON: the route answers 400 naming the cursor.
    return undefined;
  }
  const parsed = CURSOR.safeParse(decoded);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function writeCursor({ rank, key }: CatalogSearchPosition, ranked: Ranking): string {
  return Buffer.from(JSON.stringify({ ...ranked, rank, key })).toString("base64url");
}

/**
 * What the route does with a request. `empty` is a well-formed query nothing in the catalog can
 * match: a scheme we never settle or an extension we never catalog. `search.limit` is one more
 * than the page, so the route knows whether a next page exists. `cursor` is how the page before
 * was ranked, when the request sent one.
 */
export type SearchQuery =
  | { kind: "query"; search: CatalogSearch; limit: number; ignored: string[]; cursor?: Ranking }
  | { kind: "empty"; ignored: string[] }
  | { kind: "invalid"; param: string };

/**
 * Parses `/discovery/search`'s query string the way `parseDiscoveryQuery` parses the list's:
 * empty values count as absent, unknown params are ignored, misspelled known ones refused, and
 * `network` is a filter like any other, both networks searched without it (0155). `query` is
 * required and must hold more than spaces. `limit` is clamped to 1..100, so a page always moves
 * the cursor on.
 */
export function parseSearchQuery(raw: Record<string, unknown>): SearchQuery {
  const misspelled = Object.keys(raw).find((param) => misspelledKnown(param, KNOWN_PARAMS));
  if (misspelled !== undefined) return { kind: "invalid", param: misspelled.slice(0, 64) };
  const given = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ""));
  const parsed = QUERY.safeParse(given);
  if (!parsed.success) return { kind: "invalid", param: String(parsed.error.issues[0]!.path[0]) };
  const { query, scheme, extensions, limit: asked, cursor, ...filters } = parsed.data;
  const after = cursor === undefined ? undefined : readCursor(cursor);
  if (cursor !== undefined && after === undefined) return { kind: "invalid", param: "cursor" };
  const limit = Math.max(1, Math.min(asked ?? DISCOVERY_LIMIT.default, DISCOVERY_LIMIT.max));
  const ignored = Object.keys(raw).filter((param) => !KNOWN_PARAMS.includes(param));
  if (
    (scheme !== undefined && !CATALOGED_SCHEMES.includes(scheme)) ||
    (extensions !== undefined && !CATALOGED_EXTENSIONS.includes(extensions))
  )
    return { kind: "empty", ignored };
  const search: CatalogSearch = { text: query, ...filters, limit: limit + 1 };
  if (after === undefined) return { kind: "query", search, limit, ignored };
  search.after = { rank: after.rank, key: after.key };
  const { ranking, model } = after;
  return { kind: "query", search, limit, ignored, cursor: { ranking, model } };
}

/**
 * `GET /discovery/search` (0120) with upstream's search types (ADR 0014). It asks the search model
 * for the query's vector and ranks by meaning and words fused; every match is ranked, so
 * `partialResults` is `false` unless a listing that passes the filters has no vector yet. When the model fails or doesn't answer within its timeout, it ranks
 * by words alone, logged and counted, and `partialResults` is `true`:
 * matches by meaning were not looked for. A fused cursor while it ranks by words gets a 503 to
 * retry; a cursor of another ranking or model, a 400. A fused query slower than `SEARCH_SLOW_MS`
 * is logged and counted. A store failure rejects, and the shared error handler answers it with a
 * 500. `now` is the clock the payments' 30-day window ends at.
 */
export function discoverySearch(
  catalog: CatalogStore,
  embedder: Embedder,
  logger: Logger,
  metrics: ProcessMetrics,
  now: () => number = Date.now,
): RequestHandler {
  return async (req, res) => {
    const parsed = parseSearchQuery(req.query);
    if (parsed.kind === "invalid") {
      res.status(400).json({ error: "bad_request", param: parsed.param });
      return;
    }
    if (parsed.ignored.length > 0) {
      // Names only, capped, as the list route logs them: they come from the caller.
      const params = parsed.ignored.slice(0, 10).map((param) => param.slice(0, 64));
      logger.info("discovery_unknown_params", { params });
      metrics.increment("discovery_unknown_params_total");
    }
    if (parsed.kind === "empty") {
      // No ranking could find a match, so none was left out.
      const body: SearchDiscoveryResourcesResponse = {
        x402Version: 2,
        resources: [],
        partialResults: false,
        pagination: { limit: 0, cursor: null },
      };
      res.json(body);
      return;
    }
    let meaning: number[] | undefined;
    try {
      meaning = await embedder.embed(parsed.search.text, "query");
    } catch (error) {
      logger.warn("search_words_only", { error });
      metrics.increment("search_words_only_total");
    }
    const ranked: Ranking =
      meaning === undefined
        ? { ranking: "words" }
        : { ranking: "fused", model: catalog.searchModel };
    if (parsed.cursor?.ranking === "fused" && ranked.ranking === "words") {
      // The server fell back, not the client: the same cursor goes on once the model answers.
      res.setHeader("Retry-After", `${SEARCH_MODEL_RETRY_AFTER_S}`);
      res.status(503).json({ error: "search_model_unavailable", param: "cursor" });
      return;
    }
    if (
      parsed.cursor !== undefined &&
      (parsed.cursor.ranking !== ranked.ranking || parsed.cursor.model !== ranked.model)
    ) {
      // Its rank has another scale than this ranking's, for good (a words cursor from before the
      // model, or another model's): the client starts again.
      res.status(400).json({ error: "bad_request", param: "cursor" });
      return;
    }
    const startedAt = performance.now();
    const hits = await catalog.search(
      meaning === undefined ? parsed.search : { ...parsed.search, meaning },
      now(),
    );
    const ms = Math.round(performance.now() - startedAt);
    if (meaning !== undefined && ms > SEARCH_SLOW_MS) {
      logger.warn("search_slow", { ms, hits: hits.length });
      metrics.increment("search_slow_total");
    }
    const page = hits.slice(0, parsed.limit);
    const more = hits.length > parsed.limit;
    const body: SearchDiscoveryResourcesResponse = {
      x402Version: 2,
      resources: page.map((hit) => hit.resource),
      // Partial too while a listing that passes the filters has no vector yet: search by meaning
      // can't find it (ADR 0014).
      partialResults: meaning === undefined || (await catalog.waitingForVector(parsed.search)),
      pagination: {
        limit: page.length,
        cursor: more ? writeCursor(page.at(-1)!, ranked) : null,
      },
    };
    res.json(body);
  };
}
