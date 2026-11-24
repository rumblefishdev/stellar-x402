/** How many clients one limiter remembers before it forgets the windows that have ended. */
const SWEEP_ABOVE = 10_000;

export interface RateLimiter {
  /** Counts a request by `key`. `retryAfterSeconds` is set when it is over the limit. */
  hit(key: string): { allowed: boolean; retryAfterSeconds?: number };
}

/**
 * At most `limit` requests per `windowMs` for each key, in fixed windows, counted in this
 * process's memory: the portal is one process, and a restart forgetting the counts costs nothing.
 */
export function rateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const at = now();
      if (windows.size > SWEEP_ABOVE) {
        for (const [held, window] of windows) if (window.resetAt <= at) windows.delete(held);
      }
      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        window = { count: 0, resetAt: at + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count <= limit) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - at) / 1000) };
    },
  };
}
