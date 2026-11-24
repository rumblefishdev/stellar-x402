/** RFC 3339 in whole seconds, UTC: "2026-12-01T00:00:00Z". */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Whether a key revoked at `lastRevokedAt` (ms) still holds back a new one at `nowMs`: one new
 * key a calendar month (UTC) after a revoke, so revoking and re-issuing can't be cycled (decision 24).
 */
export function capOf(
  lastRevokedAt: number | undefined,
  nowMs: number,
): { capped: false } | { capped: true; nextEligibleAt: string } {
  if (lastRevokedAt === undefined) return { capped: false };
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (lastRevokedAt < start) return { capped: false };
  // Date.UTC rolls month 12 over to January of the next year.
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { capped: true, nextEligibleAt: rfc3339(next) };
}
