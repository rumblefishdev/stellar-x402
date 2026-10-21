import type { StellarNetwork } from "@stellar-x402/config";
import type { DiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { CatalogQuery, CatalogStore } from "../ports/index.js";

/** AD-20: `limit` is bounded, with a fixed default. 100 is every known x402 facilitator's max. */
export const DISCOVERY_LIMIT = { default: 20, max: 100 } as const;
/**
 * Deeper pages are refused. The cap is high, so every entry of a catalog this size can be paged
 * to: a deep offset costs about as much as the exact `total` every call counts anyway (15 ms at
 * offset 99 000 of 100 000 entries, 9 ms at 0), and filters can't narrow an unknown catalog.
 */
export const MAX_OFFSET = 1_000_000;
/** A `G…` address is 56 characters and a CAIP-2 id a few dozen; anything longer is noise. */
const MAX_VALUE_LENGTH = 256;
/** Entries come only from our own settlements, and T1 settles `exact` alone (0015 adds `upto`). */
const CATALOGED_SCHEMES: readonly string[] = ["exact"];
/** The parameters upstream's `listResources` sends. */
const KNOWN_PARAMS = ["type", "payTo", "scheme", "network", "extensions", "limit", "offset"];
const KNOWN_LOWER = new Set(KNOWN_PARAMS.map((param) => param.toLowerCase()));

/**
 * A name meant as a known param but not written as one: with brackets (Express 5's query parser
 * keeps them in the name, so `?type[]=http` arrives as `type[]`), in another case (`payto`) or
 * with spaces (`type `). As an unknown param it would be ignored and the whole catalog returned
 * unfiltered. Names further off (`pay_to`, `types`) stay unknown, as a new upstream filter might.
 */
function misspelledKnown(param: string): boolean {
  if (KNOWN_PARAMS.includes(param)) return false;
  return KNOWN_LOWER.has(param.split("[")[0]!.trim().toLowerCase());
}

/**
 * One value per parameter: a repeated one (`?type=a&type=b`) arrives as an array and fails here,
 * as do control characters such as NUL, which PostgreSQL rejects in text.
 */
const text = z
  .string()
  .max(MAX_VALUE_LENGTH)
  .regex(/^\P{Cc}*$/u);
/**
 * Plain decimal digits only: `Number()` would read `" "` as 0, `0x10` as 16 and `1e3` as 1000. Any
 * number of them, so a huge `limit` is clamped like any other above the max (AD-20).
 */
const count = z.string().max(MAX_VALUE_LENGTH).regex(/^\d+$/).transform(Number);

const QUERY = z.object({
  type: text.optional(),
  payTo: text.optional(),
  scheme: text.optional(),
  // CAIP-2: a malformed id is a 400; a well-formed one we don't serve matches nothing.
  network: text.regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/).optional(),
  extensions: text.optional(),
  // 0 asks for the total alone.
  limit: count.optional(),
  offset: count.pipe(z.number().max(MAX_OFFSET)).optional(),
});

/**
 * What the route does with a request. `empty` is a well-formed query nothing in the catalog can
 * match: another network, or a scheme we never settle. `ignored` names unknown parameters.
 */
export type DiscoveryQuery =
  | { kind: "query"; query: CatalogQuery; limit: number; offset: number; ignored: string[] }
  | { kind: "empty"; limit: number; offset: number; ignored: string[] }
  | { kind: "invalid"; param: string };

/**
 * Parses `/discovery/resources`' query string (AD-20) at the HTTP adapter, so the store only sees
 * a typed `CatalogQuery`. A `limit` above the max is clamped, and the page reports the limit it
 * used. Unknown parameters are ignored rather than refused: upstream's client sends whatever its
 * version knows, and a 400 would fail every call it makes once upstream adds a filter. An empty
 * value counts as absent, since that client sends `?type=` for `type: ""`. A misspelled known
 * param (`type[]`, `payto`) is refused whatever its value, naming it as sent. `served` is the
 * network this facilitator settles on, the only one its catalog holds (ADR 0012): asking for it
 * filters nothing, and is not passed on, since a filter every entry matches only slows the count.
 */
export function parseDiscoveryQuery(
  raw: Record<string, unknown>,
  served: StellarNetwork,
): DiscoveryQuery {
  const misspelled = Object.keys(raw).find(misspelledKnown);
  if (misspelled !== undefined) return { kind: "invalid", param: misspelled.slice(0, 64) };
  const given = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ""));
  const parsed = QUERY.safeParse(given);
  if (!parsed.success) return { kind: "invalid", param: String(parsed.error.issues[0]!.path[0]) };
  const { scheme, network, limit: asked, offset = 0, ...filters } = parsed.data;
  const limit = Math.min(asked ?? DISCOVERY_LIMIT.default, DISCOVERY_LIMIT.max);
  const ignored = Object.keys(raw).filter((param) => !KNOWN_PARAMS.includes(param));
  if (
    (network !== undefined && network !== served) ||
    (scheme !== undefined && !CATALOGED_SCHEMES.includes(scheme))
  )
    return { kind: "empty", limit, offset, ignored };
  return { kind: "query", query: { ...filters, limit, offset }, limit, offset, ignored };
}

/**
 * `GET /discovery/resources` (AD-20) with upstream's list types. A store failure rejects, and the
 * shared error handler answers it with a 500.
 */
export function discoveryResources(
  catalog: CatalogStore,
  logger: Logger,
  metrics: Metrics,
  served: StellarNetwork,
): RequestHandler {
  return async (req, res) => {
    const parsed = parseDiscoveryQuery(req.query, served);
    if (parsed.kind === "invalid") {
      res.status(400).json({ error: "bad_request", param: parsed.param });
      return;
    }
    if (parsed.ignored.length > 0) {
      // Names only, capped: they come from the caller. A new upstream filter shows up here first.
      const params = parsed.ignored.slice(0, 10).map((param) => param.slice(0, 64));
      logger.info("discovery_unknown_params", { params });
      metrics.increment("discovery_unknown_params_total");
    }
    const { limit, offset } = parsed;
    const page =
      parsed.kind === "empty" ? { items: [], total: 0 } : await catalog.list(parsed.query);
    const body: DiscoveryResourcesResponse = {
      x402Version: 2,
      items: page.items,
      pagination: { limit, offset, total: page.total },
    };
    res.json(body);
  };
}
