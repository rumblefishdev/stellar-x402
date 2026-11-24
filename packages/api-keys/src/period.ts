/**
 * The quota month: the calendar month in UTC (S-design §3). Its first instant, the 1st at
 * 00:00:00.000, belongs to the new month, as in Prices' `period.rs`.
 */

/** The 1st of `now`'s month at 00:00:00.000 UTC, in epoch ms. */
export function monthStart(now: number): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

/** The next month's start: the first instant that no longer counts in `now`'s month. */
export function monthEnd(now: number): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/**
 * An instant as an answer writes it: RFC 3339 in UTC, to the second (`2026-12-01T00:00:00Z`).
 * The milliseconds are dropped, not rounded, so an instant never moves into the next second.
 */
export function utcInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
