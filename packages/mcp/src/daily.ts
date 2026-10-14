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

/** Rows older than this are deleted when a payment is counted; only today's are ever read. */
const KEEP_DAYS = 7;

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

const opened = new Map<string, DatabaseSync>();

function database(dir: string): DatabaseSync {
  let db = opened.get(dir);
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, "spent.sqlite"));
  // Wait for another process's transaction instead of failing; a counted payment survives a power cut.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS spent (day TEXT NOT NULL, payer TEXT NOT NULL, asset TEXT NOT NULL, amount INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS spent_by_day ON spent (day, payer, asset)",
  );
  opened.set(dir, db);
  return db;
}

/** Spent by `payer` on `day` per asset. */
export function spentOn(dir: string, day: string, payer: string): Map<string, bigint> {
  const query = database(dir).prepare(
    "SELECT asset, SUM(amount) AS total FROM spent WHERE day = ? AND payer = ? GROUP BY asset",
  );
  query.setReadBigInts(true);
  const rows = query.all(day, payer) as { asset: string; total: bigint }[];
  return new Map(rows.map((row) => [row.asset, row.total]));
}

/**
 * Counts `amount` against `entry` if it stays within `daily`; false when it would not. BEGIN IMMEDIATE
 * takes the write lock before the read, so another process cannot count between the read and the insert.
 */
export function countDaily(dir: string, entry: DailyEntry, amount: bigint, daily: bigint): boolean {
  const db = database(dir);
  db.exec("BEGIN IMMEDIATE");
  try {
    const spent = spentOn(dir, entry.day, entry.payer).get(entry.asset) ?? 0n;
    if (spent + amount > daily) {
      db.exec("ROLLBACK");
      return false;
    }
    insert(db, entry, amount);
    const oldest = utcDay(new Date(Date.parse(entry.day) - KEEP_DAYS * 86_400_000));
    db.prepare("DELETE FROM spent WHERE day < ?").run(oldest);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    // Some errors (a full disk) end the transaction themselves; then ROLLBACK fails too, and both show.
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new Error(`${String(error)}, then ${String(rollbackError)}`, { cause: rollbackError });
    }
    throw error;
  }
}

/** Gives back an amount whose payment was never signed, in the day it was counted on. */
export function refundDaily(dir: string, entry: DailyEntry, amount: bigint): void {
  insert(database(dir), entry, -amount);
}

function insert(db: DatabaseSync, { day, payer, asset }: DailyEntry, amount: bigint): void {
  db.prepare("INSERT INTO spent VALUES (?, ?, ?, ?)").run(day, payer, asset, amount);
}
