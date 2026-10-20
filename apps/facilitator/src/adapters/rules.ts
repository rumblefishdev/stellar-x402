import type { PaymentRequirements } from "@x402/core/types";
import {
  FINAL_SETTLEMENT_STATES,
  type CatalogEntry,
  type SettlementState,
} from "../ports/index.js";

/**
 * Rules every store adapter shares, so the memory and durable adapters can't drift: the
 * settlement lifecycle order (AD-16) and the catalog merge (AD-19). Pure functions, no I/O.
 */

const ORDER: Record<SettlementState, number> = {
  claimed: 0,
  signed: 1,
  pending: 2,
  success: 3,
  failed: 3,
  rejected: 3,
  expired: 3,
};

/** `claimed`, `signed`, `pending`: every state ranked below the final ones. */
export const NON_FINAL_STATES: readonly SettlementState[] = (
  Object.keys(ORDER) as SettlementState[]
).filter((state) => ORDER[state] < ORDER.success);

export const isFinal = (state: SettlementState): boolean => FINAL_SETTLEMENT_STATES.includes(state);

/**
 * Whether a record in `expected` may move to `next`: never from a final state, and only forward,
 * since a same-state update would let two concurrent callers both win.
 */
export const isForward = (expected: SettlementState, next: SettlementState): boolean =>
  !isFinal(expected) && ORDER[next] > ORDER[expected];

export function assertLedger(ledger: number): void {
  if (!Number.isSafeInteger(ledger) || ledger < 0)
    throw new RangeError("catalog entry ledger must be a non-negative integer");
}

/** The end of the fixed rate-limit window of `windowMs` that contains `now`. */
export const windowEnd = (now: number, windowMs: number): number =>
  (Math.floor(now / windowMs) + 1) * windowMs;

const requirementKey = (r: PaymentRequirements) => `${r.scheme}|${r.network}|${r.asset}`;

/**
 * Merges `entry` into the `stored` one of the same key. `accepts` merge by
 * `scheme + network + asset`. A write from an earlier ledger (`stale`) keeps `stored`'s fields and
 * only adds the requirements it lacks; otherwise `entry`'s fields win and its requirements replace
 * matching ones. The result shares objects with its inputs; the caller copies it if it must.
 * Callers run `assertLedger(entry.ledger)` first: a `NaN` ledger would compare as not stale.
 */
export function mergeCatalogEntry(
  stored: CatalogEntry | undefined,
  entry: CatalogEntry,
): { merged: CatalogEntry; stale: boolean } {
  const stale = stored !== undefined && entry.ledger < stored.ledger;
  const accepts = new Map<string, PaymentRequirements>();
  for (const requirement of stored?.resource.accepts ?? [])
    accepts.set(requirementKey(requirement), requirement);
  for (const requirement of entry.resource.accepts)
    if (!stale || !accepts.has(requirementKey(requirement)))
      accepts.set(requirementKey(requirement), requirement);
  const latest = stale ? stored : entry;
  return {
    merged: { ...latest, resource: { ...latest.resource, accepts: [...accepts.values()] } },
    stale,
  };
}
