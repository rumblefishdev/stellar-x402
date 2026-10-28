import type { DiscoveryResource } from "@x402/extensions/bazaar";
import {
  FINAL_SETTLEMENT_STATES,
  type AttemptState,
  type SettlementState,
} from "../ports/index.js";

/**
 * Rules the store adapters apply: the settlement lifecycle order (AD-16) and the catalog's
 * checks (AD-19). Pure functions, no I/O.
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

const ATTEMPT_ORDER: Record<AttemptState, number> = {
  stored: 0,
  sent: 1,
  unknown: 1,
  landed: 2,
  dead: 2,
};

/** Whether an attempt in `current` may move to `next`: only forward (0019 decision 7). */
export const isAttemptForward = (current: AttemptState, next: AttemptState): boolean =>
  ATTEMPT_ORDER[next] > ATTEMPT_ORDER[current];

/** `ATTEMPT_ORDER` as a SQL expression over `column`; a null column is `stored`. */
export const attemptRankSql = (column: string): string =>
  `CASE coalesce(${column}, 'stored') ${Object.entries(ATTEMPT_ORDER)
    .map(([state, rank]) => `WHEN '${state}' THEN ${rank}`)
    .join(" ")} END`;

/** `name` is a catalog entry's `ledger` or `checkedAt`. */
export function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`catalog entry ${name} must be a non-negative integer`);
}

/** The largest PostgreSQL `bigint`, the column every stroop amount is stored in. */
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Rejects a stroop amount below zero or above the int64 maximum: PostgreSQL would store a negative
 * one or fail with an out-of-range error.
 */
export function assertStroops(amount: bigint, name: string): void {
  if (typeof amount !== "bigint" || amount < 0n || amount > INT64_MAX)
    throw new RangeError(`${name} must be a non-negative int64 amount of stroops`);
}

/** The end of the fixed rate-limit window of `windowMs` that contains `now`. */
export const windowEnd = (now: number, windowMs: number): number =>
  (Math.floor(now / windowMs) + 1) * windowMs;

/**
 * The keys an `extensions` filter matches: the own keys of `resource.extensions` that have a
 * value, when it is a plain object. JSON storage drops a key without a value, and an array's index
 * is not an extension key.
 */
export function extensionKeys({ extensions }: DiscoveryResource): string[] {
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) return [];
  return Object.keys(extensions).filter((key) => extensions[key] !== undefined);
}
