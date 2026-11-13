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

/** A key's SHA-256 as the registry stores it: 64 lower-case hex digits. */
const API_KEY_HASH = /^[0-9a-f]{64}$/;

/** The longest API key owner. It is part of a rate-limit key, which a b-tree index must hold. */
export const API_KEY_OWNER_MAX_LENGTH = 128;

/** `<kind>:<id>`, e.g. `operator:acme-weather` or `discord:412345678901234567` (0105). */
const API_KEY_OWNER = /^[a-z]+:[a-z0-9][a-z0-9_-]*$/;

/** Whether `owner` is an API key owner the registry takes; `0013_api_keys` checks the same. */
export const isApiKeyOwner = (owner: string): boolean =>
  owner.length <= API_KEY_OWNER_MAX_LENGTH && API_KEY_OWNER.test(owner);

/**
 * Rejects what the registry must never hold: anything but a SHA-256 in the hash column, where a
 * caller's mistake would put the key itself, and an owner that isn't `<kind>:<id>`.
 */
export function assertApiKey(hash: string, owner: string): void {
  if (!API_KEY_HASH.test(hash))
    throw new RangeError("an API key hash must be 64 lower-case hex digits");
  if (!isApiKeyOwner(owner))
    throw new RangeError(
      `an API key owner must be <kind>:<id> in a-z, 0-9, "_" and "-", at most ${API_KEY_OWNER_MAX_LENGTH} characters`,
    );
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
