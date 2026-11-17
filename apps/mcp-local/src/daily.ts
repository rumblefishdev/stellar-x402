import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The daily budget is a SQLite database, `<dir>/spent.sqlite`, shared by every server process of the
 * buyer, so a restart or a second Claude session does not start the day again from zero. A counted
 * payment is a row (day, payer, asset, amount), a refund the same with a negative amount; spent on a
 * day is the sum of its rows for the payer and asset, so wallets sharing the directory stay apart.
 * Counting runs in a write transaction, so processes paying at once never pass the day together.
 */

/** Where an amount is counted: the day, the buyer's address and the asset contract. */
export interface DailyEntry {
  day: string;
  payer: string;
  asset: string;
}

/** The day a payment counts against: the UTC date, the same for every process whatever its zone. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Opens the database for one read or count and is closed after it. A connection kept open would
 * keep counting into a deleted file after a reset, while new servers count in a fresh one.
 */
function open(dir: string): DatabaseSync {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "spent.sqlite"));
  // Wait for another process's transaction instead of failing; a counted payment survives a power cut.
  // The default rollback journal is kept: switching a new file to WAL is not covered by the wait, and
  // failed for one of 500 processes creating the database at once.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS spent (day TEXT NOT NULL, payer TEXT NOT NULL, asset TEXT NOT NULL, amount INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS spent_by_day ON spent (day, payer, asset)",
  );
  return db;
}

/**
 * Counts `amount` against `entry` if it stays within `daily`; false when it would not. BEGIN IMMEDIATE
 * takes the write lock before the read, so another process cannot count between the read and the insert.
 */
export function countDaily(dir: string, entry: DailyEntry, amount: bigint, daily: bigint): boolean {
  const db = open(dir);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const spent = sum(db, entry.day, entry.payer).get(entry.asset) ?? 0n;
      if (spent + amount > daily) {
        db.exec("ROLLBACK");
        return false;
      }
      insert(db, entry, amount);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      // Some errors (a full disk) end the transaction themselves; then ROLLBACK fails too, and both show.
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new Error(`${String(error)}, then ${String(rollbackError)}`, {
          cause: rollbackError,
        });
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Gives back an amount whose payment was never signed, in the day it was counted on. */
export function refundDaily(dir: string, entry: DailyEntry, amount: bigint): void {
  const db = open(dir);
  try {
    insert(db, entry, -amount);
  } finally {
    db.close();
  }
}

function sum(db: DatabaseSync, day: string, payer: string): Map<string, bigint> {
  const query = db.prepare(
    "SELECT asset, SUM(amount) AS total FROM spent WHERE day = ? AND payer = ? GROUP BY asset",
  );
  query.setReadBigInts(true);
  const rows = query.all(day, payer) as { asset: string; total: bigint }[];
  return new Map(rows.map((row) => [row.asset, row.total]));
}

function insert(db: DatabaseSync, { day, payer, asset }: DailyEntry, amount: bigint): void {
  db.prepare("INSERT INTO spent VALUES (?, ?, ?, ?)").run(day, payer, asset, amount);
}
