export interface RateLimitHit {
  /** Hits in the current window, including this one. */
  count: number;
  /** When the window ends, in milliseconds since the epoch. */
  resetAt: number;
}

/** Fixed-window request counters for the rate-limit middleware (AD-11). */
export interface RateLimitStore {
  /**
   * Counts one hit for `key` (e.g. `settle:ip:203.0.113.7`) in the window of `windowMs` that
   * contains `now`, atomically.
   */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}
