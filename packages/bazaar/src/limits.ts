/** Version of the catalog-key rules. Bump it when a normalization rule changes, so stored keys can be migrated. */
export const CATALOG_KEY_VERSION = 1;

/** Policy limits (see the 0030 G note). A listing over a limit is rejected; the payment never is. */
export const LIMITS = {
  /** Serialized `extensions.bazaar`, in bytes. */
  extensionBytes: 32 * 1024,
  descriptionChars: 500,
  // Upstream's output wrapper takes 4 levels and each nested object 2. Real listings go to 25
  // (92,900 measured, 2026-10-28); 10 refused two thirds of them (0083).
  schemaDepth: 32,
  schemaNodes: 1_000,
  schemaPatternChars: 256,
  routeTemplateChars: 256,
  toolNameChars: 128,
  urlChars: 2048,
  mimeTypeChars: 127,
  /**
   * One offer's serialized `extra`, in bytes, the paid one included: twice the largest measured in
   * the largest public catalog (1,846 B over 5,000 entries, 0063).
   */
  offerExtraBytes: 4 * 1024,
  /** Offers kept per listing: twice the most measured per listing key there (4, 0063). */
  offers: 8,
  /** The listing's example query or body sent to the seller with its check, in bytes (0063). */
  exampleInputBytes: 16 * 1024,
  /**
   * A whole listing, serialized, in bytes: a page of 100 stays under 1.6 MB. 5 of 95,733 listings
   * in the largest public catalog are larger (0063).
   */
  listingBytes: 16 * 1024,
} as const;

/**
 * Closed set; the value goes into `bazaar.rejectedReason` of `EXTENSION-RESPONSES` as is.
 * `resource_not_public`: a well-formed URL no buyer can reach (0054), so the entry is left out of
 * the catalog while the payment settles; not a fault in the seller's request.
 */
export const REJECT_REASONS = [
  "invalid_extension",
  "invalid_info",
  "invalid_resource_url",
  "resource_not_public",
  "too_large",
  "schema_too_complex",
  "unsupported_version",
  "internal_error",
] as const;

export type BazaarRejectReason = (typeof REJECT_REASONS)[number];

export function isRejectReason(value: string): value is BazaarRejectReason {
  return (REJECT_REASONS as readonly string[]).includes(value);
}
