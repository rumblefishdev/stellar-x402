/** Where an amount is counted: the UTC day, the buyer's address and the asset contract. */
export interface BudgetEntry {
  day: string;
  payer: string;
  asset: string;
}

/**
 * Keeps what was spent per day, so a daily budget holds across calls. A store shared by several
 * processes (a database) holds it across them; `memoryBudget` holds it for one process and forgets
 * it at exit.
 */
export interface BudgetStore {
  /**
   * Counts `amount` against `entry` if the day stays within `limit`; false when it would not. The
   * read and the count are one step: two callers at the same moment must not both pass.
   */
  count(entry: BudgetEntry, amount: bigint, limit: bigint): boolean | Promise<boolean>;
  /** Gives back an amount whose payment was never signed or sent, in the day it was counted on. */
  giveBack(entry: BudgetEntry, amount: bigint): void | Promise<void>;
}

/** The day a payment counts against: the UTC date, the same whatever the process's zone. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A budget kept in this process's memory. It starts from zero with every process, so a script run
 * again and again has no daily budget from it: use a store on disk for that.
 */
export function memoryBudget(): BudgetStore {
  const spent = new Map<string, bigint>();
  const key = ({ day, payer, asset }: BudgetEntry) => `${day}\n${payer}\n${asset}`;
  return {
    count(entry, amount, limit) {
      const total = (spent.get(key(entry)) ?? 0n) + amount;
      if (total > limit) return false;
      spent.set(key(entry), total);
      return true;
    },
    giveBack(entry, amount) {
      spent.set(key(entry), (spent.get(key(entry)) ?? 0n) - amount);
    },
  };
}
