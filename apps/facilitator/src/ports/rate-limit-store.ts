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
   * contains `now`, atomically. `windowMs` is positive: it comes from `RATE_LIMIT_WINDOW_MS`,
   * which the config schema holds at 1 s or more. A hit whose window is older than the stored one
   * (a caller with a lagging clock) counts in the stored window and keeps its `resetAt`.
   */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  /**
   * Deletes at most `limit` keys whose window ended before `before`, and resolves how many. A
   * pruned key's next hit starts a new window. Skips a key a hit is writing instead of waiting.
   */
  prune(before: number, limit: number): Promise<number>;
}
