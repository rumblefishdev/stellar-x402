/**
 * What a budget or breaker counts against (AD-18): everything, or one payer, recipient or asset.
 * Written as `global`, `payer:<G…>`, `payTo:<G…>` or `asset:<C…>`.
 */
export type SpendScope = "global" | `payer:${string}` | `payTo:${string}` | `asset:${string}`;

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

export type ReserveResult =
  | { reserved: true }
  /** Nothing was reserved; `scope` is the first budget that would be exceeded. */
  | { reserved: false; scope: SpendScope };

/** Spend budgets and circuit breakers (AD-7, AD-18). Policy lives in the settlement module. */
export interface SpendStore {
  /**
   * Reserves against all limits at once, or against none. Repeating an `id` is a no-op.
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
   * `false` when no reservation has `id`, so the fee counts against no budget; committing again
   * replaces the fee.
   */
  commit(id: string, feeCharged: bigint): Promise<boolean>;
  /** Drops a reservation that was never spent; a committed one stays, since its fee was paid. */
  release(id: string): Promise<void>;
  /** Stroops reserved or spent after `now - windowMs`, for alerts. */
  used(scope: SpendScope, windowMs: number, now: number): Promise<bigint>;

  /** Counts an on-chain failure; resolves the consecutive failures for `scope`. */
  recordFailure(scope: SpendScope, now: number): Promise<number>;
  /** Resets the consecutive failures for `scope`. */
  recordSuccess(scope: SpendScope): Promise<void>;
  /**
   * Opens the breaker for `scope` until `until` (milliseconds since the epoch). The later end
   * wins: an earlier `until`, from another task, never shortens a breaker that is open.
   */
  openBreaker(scope: SpendScope, until: number): Promise<void>;
  /** When the breaker for `scope` closes again, or `undefined` if it isn't open. */
  breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined>;
}
