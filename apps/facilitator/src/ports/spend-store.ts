/**
 * What a budget or breaker counts against (AD-18): everything, or one payer, recipient or asset.
 * Written as `global`, `payer:<G…>`, `payTo:<G…>` or `asset:<C…>`.
 */
export type SpendScope = "global" | `payer:${string}` | `payTo:${string}` | `asset:${string}`;

export interface SpendLimit {
  scope: SpendScope;
  /** Most stroops that can be reserved or spent in the rolling window. */
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
  /** Reserves against all limits at once, or against none. Repeating an `id` is a no-op. */
  reserve(reservation: SpendReservation): Promise<ReserveResult>;
  /** Replaces a reservation with the fee actually paid. */
  commit(id: string, feeCharged: bigint, now: number): Promise<void>;
  /** Drops a reservation that was never spent. */
  release(id: string): Promise<void>;
  /** Stroops reserved or spent in the window ending at `now`, for alerts. */
  used(scope: SpendScope, windowMs: number, now: number): Promise<bigint>;

  /** Counts an on-chain failure; resolves the consecutive failures for `scope`. */
  recordFailure(scope: SpendScope, now: number): Promise<number>;
  /** Resets the consecutive failures for `scope`. */
  recordSuccess(scope: SpendScope): Promise<void>;
  /** Opens the breaker for `scope` until `until` (milliseconds since the epoch). */
  openBreaker(scope: SpendScope, until: number): Promise<void>;
  /** When the breaker for `scope` closes again, or `undefined` if it isn't open. */
  breakerOpenUntil(scope: SpendScope, now: number): Promise<number | undefined>;
}
