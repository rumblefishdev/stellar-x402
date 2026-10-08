import type { StellarNetwork } from "@stellar-x402/config";
import type { DiscoveryResource } from "@x402/extensions/bazaar";

/** `network + payTo + method + normalized resource URL` (AD-19). */
export interface CatalogKey {
  network: StellarNetwork;
  payTo: string;
  /** HTTP method, or the tool name for `mcp` resources. */
  method: string;
  /** Normalized by `packages/bazaar`, with `routeTemplate` applied. */
  resourceUrl: string;
}

export interface CatalogEntry {
  key: CatalogKey;
  /** The upstream discovery shape, as returned by `GET /discovery/resources`. */
  resource: DiscoveryResource;
}

/** The `GET /discovery/resources` filters (AD-20); the route resolves `limit` before the call. */
export interface CatalogQuery {
  type?: string;
  payTo?: string;
  network?: StellarNetwork;
  /** An extension key the resource must carry, e.g. `bazaar`. */
  extensions?: string;
  limit: number;
  offset: number;
}

export interface CatalogPage {
  items: DiscoveryResource[];
  /** Matches before `limit` and `offset`. */
  total: number;
}

/** Bazaar catalog (AD-7, AD-19, AD-20). */
export interface CatalogStore {
  /** Idempotent by key; replaces the entry and its `lastUpdated`. */
  upsert(entry: CatalogEntry): Promise<void>;
  /** Matching entries in a stable order, with no ranking. */
  list(query: CatalogQuery): Promise<CatalogPage>;
}
