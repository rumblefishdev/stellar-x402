import type { Logger } from "../logger.js";
import type { NetworkMetrics } from "../metrics.js";
import type { BreakerBackoff, ScopeUsage, SpendScope, SpendStore } from "../ports/index.js";
import type { BeforeSubmitResult, SettlementHooks } from "../settlement/hooks.js";
import { SETTLE_REASONS } from "../settlement/settle.js";
import type { Verify } from "../settlement/verify.js";
import type { AssetKinds } from "./asset-kinds.js";
import { attribute, type Fault } from "./attribution.js";
import {
  assetScope,
  budgetKind,
  payToScope,
  payerScope,
  spendLimitReason,
  spendLimits,
  type SpendBudgets,
} from "./limits.js";

/** Whether the facilitator's fee account is below its floor (S-design §8). */
export interface BalanceFloor {
  /** True below the floor, and while there is no reading yet (fail closed). */
  below(): boolean;
}

/** The spend lane's settlement hooks (AD-18), and the breaker check `/verify` shares. */
export interface SpendPolicy {
  beforeSubmit: SettlementHooks["beforeSubmit"];
  onFinal: SettlementHooks["onFinal"];
  /**
   * The refusal reason of the first open breaker, in the order payer, payTo, asset, or
   * `undefined` when none is. A SAC asset never has one: its code is the host's. Rejects when the
   * store doesn't answer.
   */
  breakerRefusal(
    ctx: { payer: string; payTo: string; asset: string },
    now: number,
  ): Promise<string | undefined>;
}

/**
 * When each breaker opens and for how long (S-design §7): `failures` attributed failures in a
 * tumbling `windowMs`; a reopening multiplies the time by `factor`, up to `maxMs`, until a day
 * without an opening clears the strikes. A SAC asset has none: its code is the host's.
 */
export const BREAKERS = {
  payer: {
    failures: 3,
    /** A failure in a C-account payer's own frame is its own contract's doing, so one is enough. */
    authFailures: 1,
    windowMs: 3_600_000,
    backoff: { baseMs: 3_600_000, factor: 4, maxMs: 86_400_000, strikeResetMs: 86_400_000 },
  },
  payTo: {
    failures: 3,
    windowMs: 3_600_000,
    backoff: { baseMs: 3_600_000, factor: 4, maxMs: 86_400_000, strikeResetMs: 86_400_000 },
  },
  wasmAsset: {
    failures: 5,
    windowMs: 600_000,
    backoff: { baseMs: 600_000, factor: 2, maxMs: 21_600_000, strikeResetMs: 86_400_000 },
  },
} as const;

/** A breaker's kind, as the `breaker` label: a closed set. */
type BreakerKind = "payer" | "pay_to" | "asset";

/** A fault as the `fault` label, spelled like the other labels. */
const FAULT_LABELS: Record<Fault, string> = {
  payer: "payer",
  payTo: "pay_to",
  asset: "asset",
  ours: "ours",
};

/** How long to wait between two `reserve` attempts the store rejected. */
const RESERVE_RETRY_MS = 200;
/** A budget this full is reported as nearing its limit. */
const NEARING_PERCENT = 80n;
/** How long a scope that reported nearing stays quiet. */
const NEARING_COOLDOWN_MS = 15 * 60_000;
/** Scopes whose last report is remembered; past it the oldest is forgotten. */
const NEARING_SCOPES_MAX = 10_000;

/**
 * Checks the balance floor and the breakers before a settlement is submitted, then reserves its
 * fee ceiling against every budget that applies, all or none (S-design §5-§8). Fails closed: a
 * store that doesn't answer within the settle budget refuses the settlement.
 */
export function createSpendPolicy(deps: {
  store: SpendStore;
  assets: AssetKinds;
  floor: BalanceFloor;
  budgets: SpendBudgets;
  logger: Logger;
  metrics: NetworkMetrics;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): SpendPolicy {
  const { store, assets, floor, budgets, logger, metrics } = deps;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** When each scope last reported nearing, oldest first (a `Map` keeps insertion order). */
  const nearingAt = new Map<SpendScope, number>();

  const refuse = (errorReason: string): BeforeSubmitResult => {
    metrics.increment("spend_refused_total", { reason: errorReason });
    return { allow: false, errorReason };
  };

  async function breakerRefusal(
    ctx: { payer: string; payTo: string; asset: string },
    at: number,
  ): Promise<string | undefined> {
    const tier = assets.tier(ctx.asset);
    const payer = payerScope(ctx.payer, ctx.asset, tier);
    const payTo = payToScope(ctx.payTo, ctx.asset, tier);
    const asset = assetScope(ctx.asset);
    // A SAC never has an asset breaker: its code is the host's, so its scope isn't even checked.
    const wasm = (await assets.kind(ctx.asset)) === "wasm";
    const scopes = wasm ? [payer, payTo, asset] : [payer, payTo];
    // One read for every scope that applies, in the order payer, payTo, asset.
    const open = await store.breakersOpen(scopes, at);
    if (open.has(payer)) return SETTLE_REASONS.breakerOpenPayer;
    if (open.has(payTo)) return SETTLE_REASONS.breakerOpenPayTo;
    if (wasm && open.has(asset)) return SETTLE_REASONS.breakerOpenAsset;
    return undefined;
  }

  /** Reports each budget at or past 80 %, at most once per scope in the cooldown. */
  function nearing(usage: ScopeUsage[], at: number) {
    for (const { scope, usedStroops, maxStroops } of usage) {
      if (usedStroops * 100n < maxStroops * NEARING_PERCENT) continue;
      const last = nearingAt.get(scope);
      if (last !== undefined && at - last < NEARING_COOLDOWN_MS) continue;
      // Delete first, so the scope moves to the end: the first key is the oldest report.
      nearingAt.delete(scope);
      nearingAt.set(scope, at);
      if (nearingAt.size > NEARING_SCOPES_MAX) {
        const oldest = nearingAt.keys().next().value;
        if (oldest !== undefined) nearingAt.delete(oldest);
      }
      // The address is in the line only: a label holds the budget's kind, a closed set.
      logger.warn("spend_budget_nearing", {
        scope,
        used: usedStroops,
        max: maxStroops,
        windowMs: budgets.windowMs,
      });
      metrics.increment("spend_budget_nearing_total", { budget: budgetKind(scope) });
    }
  }

  /**
   * Counts one attributed failure in `scope` and opens its breaker when it reaches `threshold`,
   * or at once while strikes from an opening within `strikeResetMs` remain (half-open: the next
   * failure after it closed reopens it at the next step). A breaker already open only counts: an
   * opening on it would add nothing. `successes` caps a wasm asset: it opens only once its
   * failures reach its successes.
   */
  async function feed(
    scope: SpendScope,
    breaker: BreakerKind,
    rule: { windowMs: number; backoff: BreakerBackoff },
    threshold: number,
    at: number,
    ratio = false,
  ) {
    const counts = await store.recordFailure(scope, at, rule.windowMs);
    const striking =
      counts.strikes > 0 &&
      counts.lastOpenedAt !== undefined &&
      at - counts.lastOpenedAt <= rule.backoff.strikeResetMs;
    if (counts.failures < threshold && !striking) return;
    if (ratio && counts.failures < counts.successes) return;
    if ((await store.breakerOpenUntil(scope, at)) !== undefined) return;
    // Another instance may open it in between: the store then returns its end, with no strike.
    const until = await store.openBreaker(scope, at, rule.backoff);
    logger.warn("spend_breaker_opened", { scope, until });
    metrics.increment("spend_breaker_opened_total", { breaker });
  }

  return {
    breakerRefusal,

    async beforeSubmit(ctx) {
      const { key, payer, payTo, asset } = ctx;
      if (floor.below()) return refuse(SETTLE_REASONS.facilitatorUnderfunded);

      let breaker: string | undefined;
      try {
        breaker = await breakerRefusal({ payer, payTo, asset }, ctx.now);
      } catch (error) {
        // Fail closed: a breaker that can't be read may be open.
        metrics.increment("spend_store_failures_total", { op: "breaker" });
        logger.warn("spend_store_failed", { op: "breaker", key, error });
        return refuse(SETTLE_REASONS.spendStoreUnavailable);
      }
      if (breaker !== undefined) return refuse(breaker);

      const id = reservationId(key, ctx.reopened);
      const reservation = {
        id,
        amount: ctx.maxFeeStroops,
        limits: spendLimits({ payer, payTo, asset }, assets.tier(asset), budgets),
        now: ctx.now,
      };
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await store.reserve(reservation);
          if (result.reserved) {
            nearing(result.usage, ctx.now);
            return { allow: true };
          }
          // Released: the record turned final while this call waited, so nothing may be sent.
          if ("released" in result) return refuse(SETTLE_REASONS.refused);
          logger.info("spend_limit_reached", { key, scope: result.scope });
          return refuse(spendLimitReason(budgetKind(result.scope)));
        } catch (error) {
          // Busy or unreachable: nothing new was reserved, or the answer to a reservation that
          // landed was lost. A retry with the same id is a no-op for the latter.
          metrics.increment("spend_store_failures_total", { op: "reserve" });
          logger.warn("spend_store_failed", { op: "reserve", key, attempt, error });
          if (now() + RESERVE_RETRY_MS >= ctx.deadline) break;
          await sleep(RESERVE_RETRY_MS);
        }
      }
      // A reservation whose answer was lost would count until it leaves the window: release it.
      // The refusal ends the record without `onFinal`, so nothing else will.
      try {
        await store.release(id, now());
      } catch (error) {
        metrics.increment("spend_store_failures_total", { op: "release" });
        logger.warn("spend_store_failed", { op: "release", key, error });
      }
      return refuse(SETTLE_REASONS.spendStoreUnavailable);
    },

    /**
     * Commits the fee charged, or releases the reservation in any final state without one, which
     * also stops a `reserve` still on its way (S-design §6). Then feeds the breakers: a failure
     * the network charged counts against whoever caused it, and a wasm asset's success counts
     * towards its ratio (§7). The accounting goes first, so a breaker write that fails can't skip
     * it; errors reach the settlement module, which logs and counts them.
     */
    async onFinal(record) {
      const at = now();
      const { key, state, feeCharged, payer, failure } = record;
      const { payTo, asset } = record.paymentRequirements;
      const id = reservationId(key, record.reopened);
      if (feeCharged === undefined) {
        await store.release(id, at);
      } else if (!(await store.commit(id, feeCharged))) {
        // The fee was paid but counts against no budget: reserved never, or pruned meanwhile.
        logger.error("spend_commit_unmatched", { key, state, feeCharged });
        metrics.increment("spend_commit_unmatched_total", { state });
      }

      if (state === "success") {
        if ((await assets.kind(asset)) === "wasm")
          await store.recordSuccess(assetScope(asset), at, BREAKERS.wasmAsset.windowMs);
        return;
      }
      // Rejected, expired and uncharged failures never reach a breaker: nobody paid for them.
      if (state !== "failed" || feeCharged === undefined) return;

      const kind = await assets.kind(asset);
      const tier = assets.tier(asset);
      // No fault (a front-run payload) feeds no breaker; the fee was committed above all the same.
      for (const fault of attribute(failure, { kind, tier, payer, payTo, asset })) {
        metrics.increment("spend_failure_attributed_total", { fault: FAULT_LABELS[fault] });
        if (fault === "ours") {
          logger.warn("spend_failure_ours", { key, failure });
        } else if (fault === "payTo") {
          const rule = BREAKERS.payTo;
          await feed(payToScope(payTo, asset, tier), "pay_to", rule, rule.failures, at);
        } else if (fault === "asset") {
          // `attribute` blames the asset only for a wasm token: a SAC's code is the host's. Open
          // its breaker only on a confirmed wasm kind: an RPC error defaults an unread asset to
          // `wasm`, and a SAC must never gain a breaker on that (0024).
          if (kind === "wasm" && assets.confirmed(asset)) {
            const rule = BREAKERS.wasmAsset;
            await feed(assetScope(asset), "asset", rule, rule.failures, at, true);
          } else if (kind === "wasm") {
            logger.warn("spend_asset_kind_unconfirmed", { key, asset });
          }
        } else {
          // A failure in a C-account payer's own frame is its contract's code failing, not bad
          // luck. Any other auth error may be the host's or a token's, so it takes the usual count.
          const own = payer.startsWith("C") && failure?.contract === payer;
          const rule = BREAKERS.payer;
          const threshold = own ? rule.authFailures : rule.failures;
          await feed(payerScope(payer, asset, tier), "payer", rule, threshold, at);
        }
      }
    },
  };
}

/**
 * One claim's reservation. A reopened record claims again while the earlier claim's `onFinal` may
 * still be on its way, so that call gives up only its own reservation, and a reserve is refused
 * after its own claim's release (0073 decisions 16, 26). A reservation no `onFinal` reaches counts
 * until it leaves the rolling window.
 */
export function reservationId(key: string, reopened: number): string {
  return `${key}#${reopened}`;
}

/** What `/verify` says for each open breaker; no address, amount or reset time (S-design §10). */
const BREAKER_MESSAGES: Record<string, string> = {
  [SETTLE_REASONS.breakerOpenPayer]:
    "the payer's settlements failed on chain too often, so its payments are refused for a while",
  [SETTLE_REASONS.breakerOpenPayTo]:
    "settlements to payTo failed on chain too often, so its payments are refused for a while",
  [SETTLE_REASONS.breakerOpenAsset]:
    "this token's settlements failed on chain too often, so its payments are refused for a while",
};

/**
 * `/verify` with the spend breakers (S-design §7): a payment every other check accepted is
 * refused while the payer's, the payTo's or (wasm) the asset's breaker is open, so a seller
 * doesn't serve what `/settle` will refuse. Budgets are not checked: `/verify` spends nothing. A
 * store that doesn't answer counts as no open breaker, logged and counted: `/settle` checks
 * again and fails closed there.
 */
export function verifyWithBreakers(
  verify: Verify,
  deps: {
    policy: Pick<SpendPolicy, "breakerRefusal">;
    logger: Logger;
    metrics: NetworkMetrics;
    now?: () => number;
  },
): Verify {
  const { policy, logger, metrics, now = Date.now } = deps;
  return async (payload, requirements, trace) => {
    const response = await verify(payload, requirements, trace);
    const { payer } = response;
    if (!response.isValid || payer === undefined) return response;
    let reason: string | undefined;
    try {
      reason = await policy.breakerRefusal(
        { payer, payTo: requirements.payTo, asset: requirements.asset },
        now(),
      );
    } catch (error) {
      metrics.increment("spend_store_failures_total", { op: "breaker" });
      logger.warn("spend_store_failed", { op: "breaker", route: "verify", payer, error });
      return response;
    }
    if (reason === undefined) return response;
    return {
      isValid: false,
      invalidReason: reason,
      invalidMessage: BREAKER_MESSAGES[reason] ?? "a breaker is open",
      payer,
    };
  };
}
