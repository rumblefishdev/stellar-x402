import {
  feeStatsInclusionFee,
  type SorobanRpc,
  type SubmitterOptions,
} from "@stellar-x402/signer-pool";
import type { Config } from "../config.js";
import type { UpstreamVerifier } from "./verify.js";

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
 * checks the simulated resource fee plus that value against the ceiling. This verifier reads the
 * current bid on each call and builds a scheme for the fee a settlement pays at that bid when the
 * bid has changed, so `/verify` refuses exactly what the pool would refuse now. Fee escalation
 * under load can still raise the pool's bid later; the pool checks its own total again before
 * signing.
 */
export function upstreamAtCurrentBid(
  inclusionFee: () => Promise<number>,
  build: (inclusionFeeStroops: number) => UpstreamVerifier,
): UpstreamVerifier {
  let current: { bid: number; scheme: UpstreamVerifier } | undefined;
  return {
    async verify(payload, requirements) {
      const bid = await inclusionFee();
      if (current?.bid !== bid) current = { bid, scheme: build(settlementInclusionFee(bid)) };
      return current.scheme.verify(payload, requirements);
    },
  };
}
