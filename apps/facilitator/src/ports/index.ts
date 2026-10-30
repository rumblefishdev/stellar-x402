import type { CatalogAttemptStore, CatalogStore } from "./catalog-store.js";
import type { RateLimitStore } from "./rate-limit-store.js";
import type { SettlementStore } from "./settlement-store.js";
import type { SpendStore } from "./spend-store.js";

export type {
  CatalogAttempt,
  CatalogAttemptOutcome,
  CatalogAttemptStage,
  CatalogAttemptStore,
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
  type AttemptBounds,
  type AttemptState,
  type AttemptUpdate,
  type ChannelLease,
  type ClaimResult,
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
  catalogAttempts: CatalogAttemptStore;
  rateLimits: RateLimitStore;
  spend: SpendStore;
}
