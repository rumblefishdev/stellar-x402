import type { SorobanRpc } from "./types.js";

export interface FeeStatsOptions {
  /** Which percentile of recent Soroban inclusion fees to bid. */
  percentile?: "p50" | "p70" | "p90" | "p95" | "p99";
  /** Floor and ceiling of the bid, in stroops. */
  min?: number;
  max?: number;
  /** How long a reading is reused, in milliseconds. */
  cacheMs?: number;
  now?: () => number;
}

/**
 * An inclusion-fee provider that bids a percentile of recent Soroban inclusion fees from
 * `getFeeStats`, clamped to [min, max]. 0006 saw mainnet at 200 stroops for p10–p99.
 * Falls back to the last good reading (or `min`) when the RPC call fails.
 */
export function feeStatsInclusionFee(
  rpc: Pick<SorobanRpc, "getFeeStats">,
  opts: FeeStatsOptions = {},
): () => Promise<number> {
  const { percentile = "p90", min = 100, max = 10_000, cacheMs = 30_000, now = Date.now } = opts;
  let cached: { value: number; at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    try {
      const stats = await rpc.getFeeStats();
      const value = Math.min(max, Math.max(min, Number(stats.sorobanInclusionFee[percentile])));
      cached = { value, at: now() };
      return value;
    } catch {
      return cached?.value ?? min;
    }
  };
}
