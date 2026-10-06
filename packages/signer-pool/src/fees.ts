import type { SorobanRpc } from "./types.js";

export interface FeeStatsOptions {
  /** Which percentile of recent Soroban inclusion fees to bid. */
  percentile?: "p50" | "p70" | "p90" | "p95" | "p99";
  /** Floor and ceiling of the bid, in stroops. */
  min?: number;
  max?: number;
  /** How long a reading is reused, in milliseconds. */
  cacheMs?: number;
  /** How long the fallback is reused after a failed call, in milliseconds. */
  failureCacheMs?: number;
  now?: () => number;
}

/**
 * An inclusion-fee provider that bids a percentile of recent Soroban inclusion fees from
 * `getFeeStats`, clamped to [min, max]. 0006 saw mainnet at 200 stroops for p10–p99.
 * Falls back to the last good reading (or `min`) when the RPC call fails, and reuses the fallback
 * for `failureCacheMs`. Concurrent callers share one `getFeeStats` call.
 */
export function feeStatsInclusionFee(
  rpc: Pick<SorobanRpc, "getFeeStats">,
  opts: FeeStatsOptions = {},
): () => Promise<number> {
  const {
    percentile = "p90",
    min = 100,
    max = 10_000,
    cacheMs = 30_000,
    failureCacheMs = 5_000,
    now = Date.now,
  } = opts;
  let cached: { value: number; until: number } | undefined;
  let inFlight: Promise<number> | undefined;
  const read = async () => {
    try {
      const stats = await rpc.getFeeStats();
      const value = Math.min(max, Math.max(min, Number(stats.sorobanInclusionFee[percentile])));
      cached = { value, until: now() + cacheMs };
      return value;
    } catch {
      const value = cached?.value ?? min;
      cached = { value, until: now() + failureCacheMs };
      return value;
    } finally {
      inFlight = undefined;
    }
  };
  return async () => {
    if (cached && now() < cached.until) return cached.value;
    return (inFlight ??= read());
  };
}
