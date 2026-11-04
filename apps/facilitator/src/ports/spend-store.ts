/**
 * What a budget or breaker counts against (AD-18): everything, one payer, recipient or asset, or
 * the tier of tokens no one vetted. Written as `global`, `payer:<address>`,
 * `payer:<address>/<asset>` (a payer's budget in one other token), `payTo:<address>`,
 * `payTo:<address>/<asset>` (likewise), `asset:<C…>` or `tier:other`. An address is a G or a C
 * account.
 */
export type SpendScope =
  "global" | "tier:other" | `payer:${string}` | `payTo:${string}` | `asset:${string}`;

export interface SpendLimit {
  scope: SpendScope;
  /**
   * Most stroops that can be reserved or spent in the rolling window: everything stamped after
   * `now - windowMs`, including a reservation stamped after `now` (another task, or one that won
   * the scope lock first).
   */
  maxStroops: bigint;
  windowMs: number;
}

export interface SpendReservation {
  /** The settlement key; one reservation per settlement. */
  id: string;
  /** Fee ceiling reserved before `submit()`, in stroops. */
  amount: bigint;
  /** Every budget the reservation counts against. */
  limits: SpendLimit[];
  now: number;
}

/** One limit's window sum after a reservation, with the reservation itself counted. */
export interface ScopeUsage {
  scope: SpendScope;
  usedStroops: bigint;
  maxStroops: bigint;
}

export type ReserveResult =
  /** `usage` has one entry per limit, in order; empty when `id` was reserved or committed. */
  | { reserved: true; usage: ScopeUsage[] }
  /** Nothing was reserved; `scope` is the first budget that would be exceeded. */
  | { reserved: false; scope: SpendScope }
  /** Nothing was reserved: `id` was released, so its settlement was given up. */
  | { reserved: false; released: true };

/** How long a reopened breaker stays open: `baseMs x factor^strikes`, at most `maxMs`. */
export interface BreakerBackoff {
  baseMs: number;
  factor: number;
  maxMs: number;
  /** Strikes clear once this long has passed since the last opening. */
  strikeResetMs: number;
}

/** Spend budgets and circuit breakers (AD-7, AD-18). Policy lives in the settlement module. */
export interface SpendStore {
  /**
   * Reserves against all limits at once, or against none. Repeating an `id` that is reserved or
   * committed is a no-op; one that was released is refused, and counts nothing.
   * Rejects when the store is busy or unreachable (a lock wait or a connection that times out, a
   * lost answer to the commit): then nothing new is reserved, or the outcome is unknown. Retrying
   * with the same `id` is safe either way, so a caller answers it as "try again", not as a failure.
   * Rejects an `amount` or `maxStroops` that isn't a non-negative int64, like `commit`'s fee.
   */
  reserve(reservation: SpendReservation): Promise<ReserveResult>;
  /**
   * Replaces a reservation with the fee actually paid. The fee keeps the reservation's time, so
   * it leaves the window with it however late the commit comes (a settlement reconciliation ends
   * after a restart); the transaction landed within its time bound after `reserve`. Resolves
   * `false` when no reservation has `id`, so the fee counts against no budget, or when it was
   * released; committing again replaces the fee.
   */
  commit(id: string, feeCharged: bigint): Promise<boolean>;
  /**
   * Gives up a reservation that was never spent: it keeps its row as `released`, stamped at its
   * own time, and counts against no budget. An unknown `id` gets a `released` row stamped `now`,
   * so a `reserve` that arrives after is refused. A committed one stays, since its fee was paid.
   */
  release(id: string, now: number): Promise<void>;
  /** Stroops reserved or spent after `now - windowMs`, for alerts. */
  used(scope: SpendScope, windowMs: number, now: number): Promise<bigint>;
  /**
   * Deletes at most `limit` reservations stamped before `before`, in any state, and
   * resolves how many. The caller keeps `before` past every window it sums, with a margin: a
   * pruned reservation counts against nothing, and a later `commit` of it resolves `false`.
   * Skips a reservation another call is writing instead of waiting on it.
   */
  prune(before: number, limit: number): Promise<number>;
  /**
   * Deletes at most `limit` fully quiescent scope rows and resolves how many: one whose window
   * ended, whose breaker (if any) closed and whose last opening all fall before `before`, and
   * that no reservation since `before` counts against, so no failure count, strike or open
   * breaker is lost and a busy budget-only scope stays. `reserve` recreates a lock row it needs,
   * and a row `reserve` holds is skipped, so the two never let reserves past one budget. The
   * caller keeps `before` past every window and the longest strike reset, with a margin. Skips a
   * row another call holds instead of waiting on it. Without it `spend_scopes` grows by one row
   * per distinct payer, recipient and asset ever seen (0024).
   */
  pruneScopes(before: number, limit: number): Promise<number>;

  /**
   * Counts an on-chain failure in the scope's window and resolves the counts. The window is
   * tumbling: it starts at the first event and restarts once `now - windowStart > windowMs`, and
   * the failures and successes restart together. `strikes` and `lastOpenedAt` (absent until the
   * first opening) are as stored: the caller judges whether they are still fresh.
   */
  recordFailure(
    scope: SpendScope,
    now: number,
    windowMs: number,
  ): Promise<{ failures: number; successes: number; strikes: number; lastOpenedAt?: number }>;
  /** Counts a success in the same window as `recordFailure`; it never resets the failures. */
  recordSuccess(scope: SpendScope, now: number, windowMs: number): Promise<void>;
  /**
   * Opens the breaker for `scope` and resolves when it closes (milliseconds since the epoch). A
   * breaker that is open at `now` is returned as it is, with no strike, so instances opening it
   * together add one. Otherwise it stays open for `baseMs x factor^strikes`, at most `maxMs`, and
   * the scope gains a strike; strikes older than `strikeResetMs` since the last opening count as
   * none. The later end wins: it is never shortened.
   */
  openBreaker(scope: SpendScope, now: number, backoff: BreakerBackoff): Promise<number>;
  /** When the breaker for `scope` closes again, or `undefined` if it isn't open. */
  breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined>;
  /**
   * Which of `scopes` have a breaker open at `now`, in one read: the refusal check on `/verify`
   * and before `/settle` asks for a payment's payer, recipient and (wasm) asset scopes together,
   * instead of a read and a pool checkout each (0024).
   */
  breakersOpen(scopes: SpendScope[], now: number): Promise<Set<SpendScope>>;
}
