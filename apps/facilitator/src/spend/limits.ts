import type { SpendLimit, SpendScope } from "../ports/index.js";
import { SETTLE_REASONS } from "../settlement/settle.js";
import type { AssetTier } from "./asset-kinds.js";

/** The fee budgets of one rolling window, in stroops (S-design §5). */
export interface SpendBudgets {
  windowMs: number;
  globalStroops: bigint;
  /** One payer in the known assets together, or in one other token. */
  perPayerStroops: bigint;
  perPayToStroops: bigint;
  /** One known asset (USDC). */
  perKnownAssetStroops: bigint;
  /** One other token: anyone can mint one, so it gets the low tier. */
  perOtherAssetStroops: bigint;
  /** All other tokens together, so junk tokens can't spend `global` that USDC sellers need. */
  tierOtherStroops: bigint;
}

/** Which budget a scope is, as the `budget` label and the refusal name it: a closed set. */
export type BudgetKind = "payer" | "pay_to" | "asset" | "other" | "global";

/**
 * The payer's scope, for its budget and its breaker alike: one for the known assets, and one per
 * other token, so a seller's own token can't use up or trip a buyer's USDC scope.
 */
export function payerScope(payer: string, asset: string, tier: AssetTier): SpendScope {
  return tier === "known" ? `payer:${payer}` : `payer:${payer}/${asset}`;
}

/**
 * The recipient's scope, for its budget and its breaker alike, split by tier like the payer's: one
 * for the known assets, and one per other token, so payments in a junk token can't use up or trip
 * a seller's USDC scope.
 */
export function payToScope(payTo: string, asset: string, tier: AssetTier): SpendScope {
  return tier === "known" ? `payTo:${payTo}` : `payTo:${payTo}/${asset}`;
}

/** The asset's scope, for its budget and, for a wasm token, its breaker. */
export function assetScope(asset: string): SpendScope {
  return `asset:${asset}`;
}

/**
 * Every budget a settlement counts against, narrowest first (payer, payTo, asset, `tier:other`
 * for another token, global): `reserve` names the first one that is full, so a refusal names the
 * narrowest budget.
 */
export function spendLimits(
  ctx: { payer: string; payTo: string; asset: string },
  tier: AssetTier,
  budgets: SpendBudgets,
): SpendLimit[] {
  const other = tier === "other";
  const limit = (scope: SpendScope, maxStroops: bigint): SpendLimit => ({
    scope,
    maxStroops,
    windowMs: budgets.windowMs,
  });
  return [
    limit(payerScope(ctx.payer, ctx.asset, tier), budgets.perPayerStroops),
    limit(payToScope(ctx.payTo, ctx.asset, tier), budgets.perPayToStroops),
    limit(
      assetScope(ctx.asset),
      other ? budgets.perOtherAssetStroops : budgets.perKnownAssetStroops,
    ),
    ...(other ? [limit("tier:other", budgets.tierOtherStroops)] : []),
    limit("global", budgets.globalStroops),
  ];
}

export function budgetKind(scope: SpendScope): BudgetKind {
  if (scope === "global") return "global";
  if (scope === "tier:other") return "other";
  if (scope.startsWith("payer:")) return "payer";
  if (scope.startsWith("payTo:")) return "pay_to";
  return "asset";
}

const SPEND_LIMIT_REASONS: Record<BudgetKind, string> = {
  payer: SETTLE_REASONS.spendLimitPayer,
  pay_to: SETTLE_REASONS.spendLimitPayTo,
  asset: SETTLE_REASONS.spendLimitAsset,
  other: SETTLE_REASONS.spendLimitOther,
  global: SETTLE_REASONS.spendLimitGlobal,
};

/** The `errorReason` of a refusal by a full budget of this kind. */
export function spendLimitReason(kind: BudgetKind): string {
  return SPEND_LIMIT_REASONS[kind];
}
