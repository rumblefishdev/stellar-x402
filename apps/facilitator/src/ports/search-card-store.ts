import type { SearchFields } from "@stellar-x402/bazaar";
import type { DiscoveryResource } from "@x402/extensions/bazaar";

/** A catalog listing as the card rewrite reads it. */
export interface CardListing {
  /** The catalog row's `seq`, as PostgreSQL's text for a bigint. */
  seq: string;
  resource: DiscoveryResource;
}

/**
 * The search cards, one per catalog listing (ADR 0014). The catalog's write keeps each card in
 * step with its listing; this store lets a starting release rewrite every card with its own rules.
 */
export interface SearchCardStore {
  /** Up to `limit` listings after `after` (a `seq`, or `null` from the start), in catalog order. */
  listings(after: string | null, limit: number): Promise<CardListing[]>;
  /**
   * Writes the card built from this copy of the listing, unless the listing has changed since:
   * then the catalog's write has already written the newer listing's card. True when written.
   */
  write(listing: CardListing, fields: SearchFields): Promise<boolean>;
}
