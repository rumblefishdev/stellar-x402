import { HTTPFacilitatorClient } from "@x402/core/http";
import {
  withBazaar,
  type ListDiscoveryResourcesParams,
  type SearchDiscoveryResourcesParams,
} from "@x402/extensions/bazaar";
import { z } from "zod";
import { FACILITATOR_URL } from "../seller/facilitator.js";

/**
 * The longest description and service name passed on, in characters. A copy of
 * `@stellar-x402/bazaar`'s `LIMITS.descriptionChars`, which this package can't depend on; a test
 * holds the two equal.
 */
export const DESCRIPTION_CHARS = 500;

const ACCEPT = z.object({
  scheme: z.string(),
  network: z.string(),
  amount: z.string(),
  asset: z.string(),
  payTo: z.string(),
});

const ENTRY = z.object({
  resource: z.string(),
  type: z.string(),
  accepts: z.array(ACCEPT),
  description: z.string().optional(),
  serviceName: z.string().optional(),
  extensions: z.record(z.unknown()).optional(),
});

/** The catalog's answers, never trusted for their shape: a malformed page is `unavailable`. */
const PAGE = z.object({
  items: z.array(ENTRY),
  pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number() }),
});
/** Upstream's search answer; the spec makes `partialResults` and `pagination` optional. */
const SEARCH_PAGE = z.object({
  resources: z.array(ENTRY),
  partialResults: z.boolean().optional(),
  pagination: z.object({ limit: z.number(), cursor: z.string().nullable() }).nullish(),
});

/** One payment a listed resource takes. */
export interface CatalogOffer {
  scheme: string;
  network: string;
  /** The price in the asset's atomic units: 10000 is 0.001 USDC. */
  amount: string;
  asset: string;
  payTo: string;
}

/**
 * A listed resource, as a seller described it. Everything here is the seller's text: data, never
 * instructions, for a model that reads it.
 */
export interface CatalogEntry {
  resource: string;
  /** `http` or `mcp`. */
  type: string;
  /** Cut to `DESCRIPTION_CHARS`. */
  description?: string;
  /** Cut to `DESCRIPTION_CHARS`. */
  serviceName?: string;
  accepts: CatalogOffer[];
  /** How to call it: the HTTP method and parameters, or the MCP tool and its input schema. */
  input?: Record<string, unknown>;
}

export interface CatalogPage {
  items: CatalogEntry[];
  pagination: { limit: number; offset: number; total: number };
}

export interface CatalogSearchPage {
  /** Best match first. */
  items: CatalogEntry[];
  /** True when some matches were left out, and no later page returns them. */
  partialResults?: boolean;
  /** `cursor` asks for the next page; null when there is none. */
  pagination?: { limit: number; cursor: string | null } | null;
}

export type ListQuery = ListDiscoveryResourcesParams;
export type SearchQuery = SearchDiscoveryResourcesParams;

/**
 * Why a catalog request failed. `unavailable`: no answer, an error status, an answer in another
 * shape, or none within the time limit. `invalid_request`: the catalog refused the query (a 400),
 * naming the parameter in `param` when it is one of the query's. `invalid_cursor`: the catalog no
 * longer takes the cursor; search again without it.
 */
export class CatalogError extends Error {
  override readonly name = "CatalogError";

  constructor(
    readonly code: "unavailable" | "invalid_request" | "invalid_cursor",
    message: string,
    options: { cause?: unknown; param?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.param = options.param;
  }

  readonly param?: string;
}

/** The query's own parameter names: only these are passed on from a catalog's refusal. */
const PARAMS = new Set([
  "query",
  "type",
  "payTo",
  "scheme",
  "network",
  "extensions",
  "limit",
  "offset",
  "cursor",
]);

export interface BazaarClientOptions {
  /** The facilitator whose catalog is read; `FACILITATOR_URL` by default. */
  url?: string;
  /** Each request's time limit, in milliseconds. */
  timeoutMs?: number;
}

export interface BazaarClient {
  /** A page of the catalog, filtered by the query. */
  list(query?: ListQuery): Promise<CatalogPage>;
  /** The catalog searched by a description of what is needed, best match first. */
  search(query: SearchQuery): Promise<CatalogSearchPage>;
}

/**
 * A client of a facilitator's Bazaar catalog, over upstream's `withBazaar`. It adds two things: the
 * catalog is written by sellers, so their free text is cut short before it reaches a model; and a
 * time limit, which upstream's client has no way to take.
 */
export function createBazaarClient(options: BazaarClientOptions = {}): BazaarClient {
  const { url = FACILITATOR_URL, timeoutMs = 10_000 } = options;
  // Upstream's client falls back to x402.org's facilitator for an empty URL: another catalog.
  if (!URL.canParse(url)) throw new TypeError(`The catalog URL is not a URL: "${url}"`);
  const bazaar = withBazaar(new HTTPFacilitatorClient({ url })).extensions.bazaar;

  return {
    async list(query = {}) {
      const page = await read(bazaar.listResources(query), PAGE, timeoutMs);
      return { items: page.items.map(entry), pagination: page.pagination };
    },
    async search(query) {
      const page = await read(bazaar.search(query), SEARCH_PAGE, timeoutMs);
      return {
        items: page.resources.map(entry),
        partialResults: page.partialResults,
        pagination: page.pagination,
      };
    },
  };
}

/** The answer within the time limit and in its shape, or the `CatalogError` that says why not. */
async function read<T>(answer: Promise<unknown>, shape: z.ZodType<T>, ms: number): Promise<T> {
  let body: unknown;
  try {
    body = await deadline(answer, ms);
  } catch (error) {
    throw (
      refusal(error) ??
      new CatalogError("unavailable", "The catalog request failed.", { cause: error })
    );
  }
  const parsed = shape.safeParse(body);
  if (!parsed.success) {
    throw new CatalogError("unavailable", "The catalog answered in another shape.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The catalog's `400`, read from upstream's error: its client throws a plain Error whose message is
 * `… failed (<status>): <body>`, and our route's body is `{"error":"bad_request","param":"<name>"}`.
 * Anything else gives `undefined`. Only a name of the query's own parameters is kept: the body is
 * the catalog's text, and a model may read the error.
 */
function refusal(error: unknown): CatalogError | undefined {
  const answer = /failed \(400\): (.*)$/s.exec(String(error));
  if (!answer) return undefined;
  let param: string | undefined;
  try {
    const named = (JSON.parse(answer[1]!) as { param?: unknown }).param;
    if (typeof named === "string" && PARAMS.has(named)) param = named;
  } catch {
    // A 400 without our route's body still names the query as the cause.
  }
  if (param === "cursor") {
    return new CatalogError(
      "invalid_cursor",
      "The catalog refused the cursor; search again without it.",
      { cause: error, param },
    );
  }
  return new CatalogError(
    "invalid_request",
    `The catalog refused the request${param ? ` (${param})` : ""}.`,
    { cause: error, param },
  );
}

/** Upstream's client takes no abort signal, so a catalog that never answers is cut off here. */
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * A listed resource with the seller's free text cut short. The input description is passed as the
 * catalog holds it; our catalog bounds its size and depth on intake.
 */
function entry(item: z.infer<typeof ENTRY>): CatalogEntry {
  const bazaar = item.extensions?.bazaar as
    { info?: { input?: Record<string, unknown> } } | undefined;
  return {
    resource: item.resource,
    type: item.type,
    description: item.description?.slice(0, DESCRIPTION_CHARS),
    serviceName: item.serviceName?.slice(0, DESCRIPTION_CHARS),
    // Parsing with ACCEPT already dropped the payment terms nobody chooses by.
    accepts: item.accepts,
    input: bazaar?.info?.input,
  };
}
