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
  /** `CATALOG_KEY_VERSION` of the rules that built `key`; stored so a rule change can be migrated. */
  keyVersion: number;
  /** Ledger of the settlement whose check wrote the entry. */
  ledger: number;
  /**
   * When the check that read the entry from the seller started, app clock in ms: it orders writes,
   * so of two checks of one key the one that started later is kept (0063).
   */
  checkedAt: number;
  /**
   * The upstream discovery shape, as returned by `GET /discovery/resources`, with the seller's
   * offers to the key's network and `payTo` in `accepts`. The caller stamps `lastUpdated`.
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

/** `stale`: the stored entry came from a check that started later; nothing was written. */
export type UpsertOutcome = "inserted" | "updated" | "stale";

/** Bazaar catalog (AD-7, AD-19, AD-20). */
export interface CatalogStore {
  /** The stored entry of `key`, as `list` returns it. */
  get(key: CatalogKey): Promise<DiscoveryResource | undefined>;
  /**
   * Idempotent by key. Replaces the stored entry, `accepts` included, unless the stored one came
   * from a check that started later (`checkedAt`). Rejects an offer the upstream
   * `PaymentRequirements` schema refuses, and a `ledger` or `checkedAt` that isn't a non-negative
   * integer.
   */
  upsert(entry: CatalogEntry): Promise<UpsertOutcome>;
  /**
   * Matching entries in insertion order, with no ranking. An upsert of an existing key keeps its
   * place, so offset paging doesn't shift each time a resource settles again.
   */
  list(query: CatalogQuery): Promise<CatalogPage>;
}

/** Where a listing attempt ended: the payment's copy, or the check of the seller's 402. */
export type CatalogAttemptStage = "payment" | "seller";

/**
 * How a listing attempt ended. On the payment's copy: `rejected` (it broke a rule), `unchanged`
 * (it matches the stored listing, so the seller isn't asked) or `over_budget`. On the seller's
 * 402: `not_askable` (no usable answer), `other_pay_to`, `other_key` (it describes another listing
 * than the one asked about), `too_large`, `rejected` (the seller's own
 * listing broke a rule), `refreshed`, `stale` (a later check had written) or `upsert_failed`. At
 * either stage, `internal_error`: the facilitator itself failed, its reason the step it failed at.
 */
export type CatalogAttemptOutcome =
  | "rejected"
  | "unchanged"
  | "over_budget"
  | "not_askable"
  | "other_pay_to"
  | "other_key"
  | "too_large"
  | "refreshed"
  | "stale"
  | "upsert_failed"
  | "internal_error";

/**
 * One listing attempt, accepted or not (0063), kept for later analysis: who paid, what was tried,
 * how it ended. No listing content, only its hash.
 */
export interface CatalogAttempt {
  /** App clock, ms. */
  at: number;
  network: string;
  payTo: string;
  payer: string;
  /** The settlement's last transaction hash. */
  transaction?: string;
  /** The payment's `resource.url`, as sent. */
  url?: string;
  /** Set once the payment's copy passed validation. */
  key?: CatalogKey;
  stage: CatalogAttemptStage;
  outcome: CatalogAttemptOutcome;
  reason?: string;
  detail?: string;
  /** The size of the field over a byte limit. */
  fieldBytes?: number;
  /** SHA-256 of the listing content tried, hex. */
  contentHash?: string;
}

/** The record of listing attempts (0063). */
export interface CatalogAttemptStore {
  record(attempt: CatalogAttempt): Promise<void>;
  /** Deletes up to `limit` attempts from before `before`; resolves how many it deleted. */
  prune(before: number, limit: number): Promise<number>;
}
