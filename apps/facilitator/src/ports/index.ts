import type { CatalogStore } from "./catalog-store.js";
import type { RateLimitStore } from "./rate-limit-store.js";
import type { SettlementStore } from "./settlement-store.js";
import type { SpendStore } from "./spend-store.js";

export type {
  CatalogEntry,
  CatalogKey,
  CatalogPage,
  CatalogQuery,
  CatalogStore,
  UpsertOutcome,
} from "./catalog-store.js";
export type { RateLimitHit, RateLimitStore } from "./rate-limit-store.js";
export {
  FINAL_SETTLEMENT_STATES,
  HashConflictError,
  LEASE_SKEW_MARGIN_MS,
  LeaseFencedError,
  type AttemptBounds,
  type AttemptState,
  type AttemptUpdate,
  type ChannelLease,
  type ClaimResult,
  type LeaseFence,
  type NewSettlement,
  type SettlementAttempt,
  type SettlementKey,
  type SettlementRecord,
  type SettlementState,
  type SettlementStore,
  type SettlementUpdate,
} from "./settlement-store.js";
export type {
  ReserveResult,
  SpendLimit,
  SpendReservation,
  SpendScope,
  SpendStore,
} from "./spend-store.js";

/** All state the facilitator keeps (AD-7), in PostgreSQL through the adapters in `adapters/`. */
export interface Stores {
  settlements: SettlementStore;
  catalog: CatalogStore;
  rateLimits: RateLimitStore;
  spend: SpendStore;
}
