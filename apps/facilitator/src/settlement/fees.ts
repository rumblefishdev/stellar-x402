import {
  feeStatsInclusionFee,
  type SorobanRpc,
  type SubmitterOptions,
} from "@stellar-x402/signer-pool";
import type { Config } from "../config.js";

export interface FeeSettings {
  /** Ceiling of the total fee, for upstream's `maxTransactionFeeStroops` and the pool. */
  maxFeeStroops: number;
  /**
   * The inclusion bid both components use now: `INCLUSION_FEE_STROOPS`, or one fee-stats
   * provider (p90, 100–10,000 stroops, read again after 30 s) shared with the pool.
   */
  inclusionFee: () => Promise<number>;
  /** Options of the pool's `SettlementSubmitter`, which pays the fee. */
  pool: Pick<SubmitterOptions, "maxFeeStroops" | "inclusionFee" | "feeEscalation">;
}

/**
 * One fee configuration for both components (AD-10), so `/verify` and the pool agree on the
 * ceiling and the bid. The client's fee is never read. The config bounds both values to safe
 * integers.
 */
export function feeSettings(
  fees: Config["fees"],
  rpc: Pick<SorobanRpc, "getFeeStats">,
): FeeSettings {
  const maxFeeStroops = Number(fees.maxFeeStroops);
  const fixed =
    fees.inclusionFeeStroops === undefined ? undefined : Number(fees.inclusionFeeStroops);
  const inclusionFee = fixed === undefined ? feeStatsInclusionFee(rpc) : async () => fixed;
  return {
    maxFeeStroops,
    inclusionFee,
    pool: { maxFeeStroops, inclusionFee, feeEscalation: fees.escalation },
  };
}

/**
 * The inclusion fee a settlement pays at bid `bid`. The pool settles under a fee bump, where the
 * inner operation and the bump each pay the bid (CAP-15), so its total is the resource fee plus
 * twice the bid (`signer-pool`'s `FeeLimitError` check).
 */
export function settlementInclusionFee(bid: number): number {
  return 2 * bid;
}

/**
 * Upstream `ExactStellarScheme` takes its inclusion fee as a constructor value, and `verify()`
 * checks the simulated resource fee plus that value against the ceiling. This reads the current
 * bid and returns what `build` made for the fee a settlement pays at that bid, built again only
 * when the bid has changed, so `/verify` refuses exactly what the pool would refuse at the same
 * bid. `/verify` builds one scheme per RPC URL with it and reads the bid once per call, before any
 * URL's deadline starts (AD-3). A fee-stats bid stays the same only within one 30 s reading, so a
 * `/settle` after the next reading can pay a different one. Fee escalation under load can also
 * raise the pool's bid later; the pool checks its own total again before signing.
 */
export function atCurrentBid<T>(
  inclusionFee: () => Promise<number>,
  build: (inclusionFeeStroops: number) => T,
): () => Promise<T> {
  let current: { bid: number; built: T } | undefined;
  return async () => {
    const bid = await inclusionFee();
    if (current?.bid !== bid) current = { bid, built: build(settlementInclusionFee(bid)) };
    return current.built;
  };
}
