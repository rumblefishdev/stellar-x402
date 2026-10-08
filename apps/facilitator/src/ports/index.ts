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
} from "./catalog-store.js";
export type { RateLimitHit, RateLimitStore } from "./rate-limit-store.js";
export {
  FINAL_SETTLEMENT_STATES,
  type ChannelLease,
  type ClaimResult,
  type NewSettlement,
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

/** All state the facilitator keeps (AD-7); the composition root picks memory or real adapters. */
export interface Stores {
  settlements: SettlementStore;
  catalog: CatalogStore;
  rateLimits: RateLimitStore;
  spend: SpendStore;
}
