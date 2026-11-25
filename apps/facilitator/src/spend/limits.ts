import { FREE_PLAN, type AccountPlan } from "@stellar-x402/api-keys";
import type { SpendLimit, SpendScope } from "../ports/index.js";
import { SETTLE_REASONS } from "../settlement/reasons.js";
import type { AssetTier } from "./asset-kinds.js";

/** The fee budgets of one rolling window, in stroops (S-design §5). */
export interface SpendBudgets {
  windowMs: number;
  globalStroops: bigint;
  /**
   * The accounts on the free plan together (0107), so many Discord accounts use up only the free
   * traffic, not the room of the accounts the operator raised.
   */
  freeStroops: bigint;
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

/** The key's owner, as the account's quota and budget scopes need it. */
export interface AccountBudget {
  owner: string;
  plan: AccountPlan;
  /** Start of the current quota month, in epoch ms. */
  monthStart: number;
}

/** Which budget a scope is, as the `budget` label and the refusal name it: a closed set. */
export type BudgetKind = "payer" | "pay_to" | "asset" | "other" | "global" | "account" | "free";

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
 * Every budget a settlement counts against, narrowest first: `reserve` names the first one that
 * is full, so a refusal names the narrowest budget.
 *
 * - With an account (a key's settlement, 0107): its month's payments, its day's fees, `free` on
 *   the free plan, and global. Never the payer, payTo, asset or tier scopes: another key's
 *   payments could fill those for this one.
 * - Without (testnet): payer, payTo, asset, `tier:other` for another token, and global.
 */
export function spendLimits(
  ctx: { payer: string; payTo: string; asset: string; account?: AccountBudget },
  tier: AssetTier,
  budgets: SpendBudgets,
): SpendLimit[] {
  const other = tier === "other";
  const limit = (scope: SpendScope, maxStroops: bigint): SpendLimit => ({
    scope,
    maxStroops,
    windowMs: budgets.windowMs,
  });
  const { account } = ctx;
  if (account) {
    const scope: SpendScope = `account:${account.owner}`;
    const { plan } = account;
    return [
      { scope, maxCount: plan.payments, since: account.monthStart },
      limit(scope, plan.dailyFeeStroops),
      ...(plan.name === FREE_PLAN ? [limit("free", budgets.freeStroops)] : []),
      limit("global", budgets.globalStroops),
    ];
  }
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
  if (scope === "free") return "free";
  if (scope.startsWith("payer:")) return "payer";
  if (scope.startsWith("payTo:")) return "pay_to";
  if (scope.startsWith("asset:")) return "asset";
  if (scope.startsWith("account:")) return "account";
  throw new Error(`unknown spend scope: ${scope}`);
}

const SPEND_LIMIT_REASONS: Record<BudgetKind, string> = {
  payer: SETTLE_REASONS.spendLimitPayer,
  pay_to: SETTLE_REASONS.spendLimitPayTo,
  asset: SETTLE_REASONS.spendLimitAsset,
  other: SETTLE_REASONS.spendLimitOther,
  global: SETTLE_REASONS.spendLimitGlobal,
  account: SETTLE_REASONS.spendLimitAccount,
  free: SETTLE_REASONS.spendLimitFree,
};

/**
 * The `errorReason` of a refusal by a full budget of this kind: its stroops, or for an account its
 * count of the month's payments, its quota.
 */
export function spendLimitReason(kind: BudgetKind, limit: "stroops" | "count" = "stroops"): string {
  return kind === "account" && limit === "count"
    ? SETTLE_REASONS.quotaExhausted
    : SPEND_LIMIT_REASONS[kind];
}

/** The longest a quota month runs, which its count sums back from at most. */
const QUOTA_MONTH_MAX_MS = 31 * 86_400_000;

/**
 * The longest window any limit sums, which the pruner keeps the rows of (0107 decision 26): the
 * budgets' rolling window, and on a network that requires an API key the account's month too,
 * counted from its 1st.
 */
export function longestSpendWindowMs(windowMs: number, keyed: boolean): number {
  return keyed ? Math.max(windowMs, QUOTA_MONTH_MAX_MS) : windowMs;
}
