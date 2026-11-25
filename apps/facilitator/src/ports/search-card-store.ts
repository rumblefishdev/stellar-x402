import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type { CatalogKey } from "./catalog-store.js";
import type { Embedding } from "./embedder.js";

/** A catalog listing as the card rewrite reads it. */
export interface CardListing {
  /** The catalog row's `seq`, as PostgreSQL's text for a bigint. */
  seq: string;
  resource: DiscoveryResource;
}

/** A listing's search card as the vector pass reads it: its four fields and its vector's model. */
export interface SearchCard {
  /** The catalog row's `seq`, as PostgreSQL's text for a bigint. */
  seq: string;
  name: string;
  tags: string;
  description: string;
  parameters: string;
  /** The model that made the stored vector; null while the card has none. */
  model: string | null;
}

/**
 * The search cards, one per catalog listing, and their vectors (ADR 0014). The catalog's write
 * keeps each card in step with its listing; this store lets a starting release rewrite every card
 * with its own rules, and the vector pass and the catalog's write store the vectors.
 */
export interface SearchCardStore {
  /** Up to `limit` listings after `after` (a `seq`; `"0"` from the start), in catalog order. */
  listings(after: string, limit: number): Promise<CardListing[]>;
  /**
   * Writes the card built (`searchFields`) from this copy of the listing, unless the listing has
   * changed since (the catalog's write has then written the newer listing's card) or its card
   * already holds this text. True when written.
   */
  write(listing: CardListing): Promise<boolean>;
  /** Up to `limit` cards without a vector after `after` (a `seq`; `"0"` from the start), in order. */
  cards(after: string, limit: number): Promise<SearchCard[]>;
  /** The card of the listing at `key`; undefined when the catalog holds no such listing. */
  card(key: CatalogKey): Promise<SearchCard | undefined>;
  /**
   * Stores `embedding` on this card, unless its fields have changed since it was read: the vector
   * would then be of an older text. True when written.
   */
  writeVector(card: SearchCard, embedding: Embedding): Promise<boolean>;
}
