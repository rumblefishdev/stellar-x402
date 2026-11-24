import type { SearchFields } from "@stellar-x402/bazaar";
import type { DiscoveryResource } from "@x402/extensions/bazaar";

/** A listing whose search card is missing or was built by other rules. */
export interface StaleListing {
  /** The catalog row's `seq`, as PostgreSQL's text for a bigint. */
  seq: string;
  resource: DiscoveryResource;
}

/** A listing's search card (0120): its fields, built by `searchFields` under a rules version. */
export interface SearchCard {
  seq: string;
  rules: number;
  fields: SearchFields;
}

/**
 * The search cards, one per catalog listing (ADR 0014). The catalog's write keeps each card in
 * step with its listing; this store carries the cards to another rules version, and writes the
 * cards of listings stored before cards existed.
 */
export interface SearchCardStore {
  /**
   * Up to `limit` listings, in catalog order, whose card is missing or was built by other rules.
   * One release runs at a time (ADR 0011), so after a rollback its rules rewrite the cards again.
   */
  stale(rules: number, limit: number): Promise<StaleListing[]>;
  /**
   * Writes the card unless the listing's card already has these rules: then the catalog's write
   * built it, from a listing as new as the one this card was built from or newer. True when
   * written.
   */
  write(card: SearchCard): Promise<boolean>;
}
