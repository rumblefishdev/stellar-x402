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
  /**
   * The upstream discovery shape, as returned by `GET /discovery/resources`. One settlement knows
   * one requirement, so `accepts` usually holds one entry. The caller stamps `lastUpdated`.
   */
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
  /**
   * Idempotent by key. Merges `accepts` by `scheme + network + asset`: a matching requirement is
   * replaced, others are kept. Every other field, `lastUpdated` included, is replaced.
   */
  upsert(entry: CatalogEntry): Promise<void>;
  /**
   * Matching entries in insertion order, with no ranking. An upsert of an existing key keeps its
   * place, so offset paging doesn't shift each time a resource settles again.
   */
  list(query: CatalogQuery): Promise<CatalogPage>;
}
