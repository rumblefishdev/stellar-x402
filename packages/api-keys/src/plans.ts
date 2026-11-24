/**
 * What an account may settle (0107): payments in a calendar month in UTC, and fee stroops in any
 * 24 hours. An account is a key's owner, so its plan outlives a revoke and a new key.
 */
export interface AccountPlan {
  name: string;
  payments: number;
  dailyFeeStroops: bigint;
}

/**
 * The plans as config text: `<name>:<payments a month>:<fee stroops per 24 h>`, comma-separated.
 * The facilitator and the portal read the same text, so they agree on every plan.
 */
export const DEFAULT_ACCOUNT_PLANS = "free:1000:20000000,basic:10000:25000000,pro:100000:100000000";

/**
 * The plan of an account without a row in the registry, which every plan text must define. The
 * facilitator counts the accounts on it in one shared fee budget.
 */
export const FREE_PLAN = "free";
const PLAN_ENTRY = /^([a-z][a-z0-9_-]*):(\d+):(\d+)$/;
/** Largest int64: a fee budget is summed against the store's `bigint` columns. */
const INT64_MAX = 9_223_372_036_854_775_807n;

/**
 * The plans in `text` by name, in its order. Throws a `RangeError` for an entry that isn't a
 * lower-case name and two whole numbers of at least 1, for a name given twice, and for text
 * without `free`.
 */
export function parseAccountPlans(text: string): Map<string, AccountPlan> {
  const plans = new Map<string, AccountPlan>();
  for (const entry of text.split(",").map((item) => item.trim())) {
    if (entry.length === 0) continue;
    const [, name, payments, fee] = PLAN_ENTRY.exec(entry) ?? [];
    if (name === undefined || payments === undefined || fee === undefined)
      throw new RangeError(
        `an account plan is <name>:<payments a month>:<fee stroops per 24 h>, not "${entry}"`,
      );
    const plan = { name, payments: Number(payments), dailyFeeStroops: BigInt(fee) };
    if (!Number.isSafeInteger(plan.payments) || plan.payments < 1)
      throw new RangeError(
        `the ${name} plan's payments must be between 1 and ${Number.MAX_SAFE_INTEGER}`,
      );
    if (plan.dailyFeeStroops < 1n || plan.dailyFeeStroops > INT64_MAX)
      throw new RangeError(`the ${name} plan's fee stroops must be between 1 and ${INT64_MAX}`);
    if (plans.has(name)) throw new RangeError(`the ${name} plan is given twice`);
    plans.set(name, plan);
  }
  if (!plans.has(FREE_PLAN))
    throw new RangeError(
      `the account plans must have ${FREE_PLAN}: an account without a plan is on it`,
    );
  return plans;
}

/** An account's plan as the registry holds it: which plan, and who set it when. */
export interface AccountPlanRecord {
  /** The account: a key's owner, `<kind>:<id>`. */
  owner: string;
  plan: string;
  setAt: number;
  /** Who set it: `operator:<name>` for the operator's script. */
  setBy: string;
  /** Why, as the operator wrote it. */
  note?: string;
}

/**
 * The account plans the operator sets by hand (0107), beside the API key registry. An account
 * without a row is on `free`. The store holds a plan's name only: the plans themselves are config.
 */
export interface AccountPlanStore {
  /** The plan name stored for `owner`, or `undefined`: the caller reads that as `free`. */
  planOf(owner: string): Promise<string | undefined>;
  /**
   * Sets `owner`'s plan, replacing the row it had, note included. Throws a `RangeError` for an
   * owner that isn't `<kind>:<id>`.
   */
  setPlan(row: {
    owner: string;
    plan: string;
    now: number;
    setBy: string;
    note?: string;
  }): Promise<void>;
  /** Every row, by owner: for the operator's script. */
  listPlans(): Promise<AccountPlanRecord[]>;
}

/**
 * An account's payments as the spend store counts them against its quota: each reservation of the
 * account that wasn't released, a failed settlement's included.
 */
export interface AccountUsageReader {
  /** Payments counted for `owner` at or after `since` (the month's start). */
  paymentsSince(owner: string, since: number): Promise<number>;
}
