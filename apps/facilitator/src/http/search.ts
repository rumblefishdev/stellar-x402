import { STELLAR_NETWORKS } from "@stellar-x402/config";
import type { SearchDiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { CatalogSearch, CatalogSearchPosition, CatalogStore } from "../ports/index.js";
import {
  CATALOGED_EXTENSIONS,
  CATALOGED_SCHEMES,
  DISCOVERY_LIMIT,
  count,
  misspelledKnown,
  network,
  text,
} from "./discovery.js";

/** The longest query served (0120): a description of a need fits, a pasted document does not. */
export const MAX_QUERY_LENGTH = 2_000;
/**
 * A cursor holds a listing's key, whose URL alone may take 2,048 characters (`LIMITS.urlChars`),
 * with a tool name of 128, an address and a network: under 3,300 characters in base64url.
 */
const MAX_CURSOR_LENGTH = 4_096;
/** The parameters upstream's `search` sends. */
const KNOWN_PARAMS = [
  "query",
  "type",
  "payTo",
  "scheme",
  "network",
  "extensions",
  "limit",
  "cursor",
];

const QUERY = z.object({
  query: z
    .string()
    .max(MAX_QUERY_LENGTH)
    .regex(/^\P{Cc}*$/u)
    .refine((query) => query.trim() !== ""),
  type: text.optional(),
  payTo: text.optional(),
  scheme: text.optional(),
  network: network.optional(),
  extensions: text.optional(),
  limit: count.optional(),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

/**
 * What the cursor carries: the last result's rank and key, and the ranking that wrote it. A rank
 * from another ranking has another scale, so its cursor is refused (ADR 0014). PR 2 of 0120 adds
 * the fused ranking and its model.
 */
const CURSOR = z.object({
  ranking: z.literal("words"),
  rank: z.string().regex(/^\d+(\.\d+)?(e-?\d+)?$/),
  key: z.tuple([
    z.enum([STELLAR_NETWORKS.testnet, STELLAR_NETWORKS.pubnet]),
    text,
    text,
    z.string().regex(/^\P{Cc}*$/u),
  ]),
});

function readCursor(cursor: string): CatalogSearchPosition | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // Not base64url JSON: the route answers 400 naming the cursor.
    return undefined;
  }
  const parsed = CURSOR.safeParse(decoded);
  if (!parsed.success) return undefined;
  const [network, payTo, method, resourceUrl] = parsed.data.key;
  return {
    rank: parsed.data.rank,
    key: { network, payTo, method, resourceUrl },
  };
}

function writeCursor(position: CatalogSearchPosition): string {
  const { network, payTo, method, resourceUrl } = position.key;
  const cursor = {
    ranking: "words",
    rank: position.rank,
    key: [network, payTo, method, resourceUrl],
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * What the route does with a request. `empty` is a well-formed query nothing in the catalog can
 * match: a scheme we never settle or an extension we never catalog. `search.limit` is one more
 * than the page, so the route knows whether a next page exists.
 */
export type SearchQuery =
  | { kind: "query"; search: CatalogSearch; limit: number; ignored: string[] }
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
  if (after !== undefined) search.after = after;
  return { kind: "query", search, limit, ignored };
}

/**
 * `GET /discovery/search` (0120) with upstream's search types, ranked by words alone: the meaning
 * part comes in the next PR, and until then `partialResults` is `true`, as ADR 0014 answers when
 * matches by meaning were not looked for. A store failure rejects, and the shared error handler
 * answers it with a 500.
 */
export function discoverySearch(
  catalog: CatalogStore,
  logger: Logger,
  metrics: ProcessMetrics,
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
    const hits = await catalog.search(parsed.search);
    const page = hits.slice(0, parsed.limit);
    const more = hits.length > parsed.limit;
    const body: SearchDiscoveryResourcesResponse = {
      x402Version: 2,
      resources: page.map((hit) => hit.resource),
      partialResults: true,
      pagination: {
        limit: page.length,
        cursor: more ? writeCursor(page.at(-1)!) : null,
      },
    };
    res.json(body);
  };
}
