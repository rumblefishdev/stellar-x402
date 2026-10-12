/** Version of the catalog-key rules. Bump it when a normalization rule changes, so stored keys can be migrated. */
export const CATALOG_KEY_VERSION = 1;

/** Policy limits (see the 0030 G note). A listing over a limit is rejected; the payment never is. */
export const LIMITS = {
  /** Serialized `extensions.bazaar`, in bytes. */
  extensionBytes: 32 * 1024,
  descriptionChars: 500,
  schemaDepth: 10,
  schemaNodes: 1_000,
  schemaPatternChars: 256,
  routeTemplateChars: 256,
  toolNameChars: 128,
  urlChars: 2048,
  mimeTypeChars: 127,
} as const;

/** Closed set; the value goes into `bazaar.rejectedReason` of `EXTENSION-RESPONSES` as is. */
export const REJECT_REASONS = [
  "invalid_extension",
  "invalid_info",
  "invalid_resource_url",
  "too_large",
  "schema_too_complex",
  "unsupported_version",
  "internal_error",
] as const;

export type BazaarRejectReason = (typeof REJECT_REASONS)[number];

export function isRejectReason(value: string): value is BazaarRejectReason {
  return (REJECT_REASONS as readonly string[]).includes(value);
}
