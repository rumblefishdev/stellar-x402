import type { SearchFields } from "@stellar-x402/bazaar";
import type { DiscoveryResource } from "@x402/extensions/bazaar";

/** A listing whose search card is missing, or older than the listing's check or the rules. */
export interface StaleListing {
  /** The catalog row's `seq`, as PostgreSQL's text for a bigint. */
  seq: string;
  /** The listing check the card is built from; `null` for a listing written before 0063. */
  checkedAt: number | null;
  resource: DiscoveryResource;
}

/** A listing's search card (0120): its fields, built by `searchFields`, from one check and rules. */
export interface SearchCard {
  seq: string;
  checkedAt: number | null;
  rules: number;
  fields: SearchFields;
}

/** The search cards, one per catalog listing (ADR 0014). */
export interface SearchCardStore {
  /**
   * Up to `limit` listings whose card is missing or built from another check or older rules,
   * those without a card first, so a new listing waits behind no rewrite of old cards.
   */
  stale(rules: number, limit: number): Promise<StaleListing[]>;
  /**
   * Writes the card, replacing the listing's card unless newer rules built it: a release rolled
   * back to older rules leaves the newer cards as they are.
   */
  write(card: SearchCard): Promise<void>;
}
