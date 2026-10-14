import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The daily budget is an append-only log, one file per UTC day: `<dir>/spent-YYYY-MM-DD.jsonl`.
 * Every server process of the buyer shares it, so a restart or a second Claude session does not start
 * the day again from zero. A counted payment appends `{"payer":"G…","asset":"C…","amount":"10000"}`,
 * a refund the same with a negative amount; spent today is the sum of today's lines for the payer
 * and asset, so two wallets sharing the directory each keep their own limit.
 *
 * There is no lock: two processes paying at the very same moment can both read the same sum and both
 * fit. The day can then be passed by at most one payment per process paying at that moment, and
 * each of those stays within its asset's `maxPerCall`. Within one process the read and the append run
 * synchronously, with no await between them, so parallel calls of one process never both fit.
 */
const LINE = z.object({
  payer: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^-?\d+$/),
});

/** Day files older than this are deleted when a line is appended; only today's is ever read. */
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

function dayFile(dir: string, day: string): string {
  return join(dir, `spent-${day}.jsonl`);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Spent by `payer` per asset in a day file's text. A line cut short (a crash, or a write that came
 * back short) has no newline of its own. The writer that comes next sees that at write time and puts
 * an empty line before its record, so the cut line stays marked even once it is no longer last. Hence
 * the rule: empty lines are skipped, and a line that does not parse is ignored (and logged) only when
 * it is the last one with no newline (cut, or still being written) or is followed by an empty line
 * (cut, then closed off). Any other malformed line, such as a hand edit, stops the read, so the day
 * is never summed from a file that may hide what was spent.
 */
function sum(text: string, file: string, payer: string, log: (message: string) => void) {
  const lines = text.split("\n");
  const spent = new Map<string, bigint>();
  for (const [i, line] of lines.entries()) {
    if (line === "") continue;
    let record: z.infer<typeof LINE>;
    try {
      record = LINE.parse(JSON.parse(line));
    } catch {
      const last = i === lines.length - 1;
      const closedOff = lines[i + 1] === "" && i + 1 < lines.length - 1;
      if (!last && !closedOff) throw new Error(`${file} line ${i + 1} is not a spent record`);
      log(`daily budget: ignored line ${i + 1} of ${file}, a write cut short by a crash`);
      continue;
    }
    const { asset, amount } = record;
    if (record.payer === payer) spent.set(asset, (spent.get(asset) ?? 0n) + BigInt(amount));
  }
  return spent;
}

/** Spent by `payer` on `day` per asset. */
export function spentOn(dir: string, day: string, payer: string, log: (message: string) => void) {
  const file = dayFile(dir, day);
  return sum(readOrEmpty(file), file, payer, log);
}

/** Counts `amount` against `entry` if it stays within `daily`; false when it would not. */
export function countDaily(
  dir: string,
  entry: DailyEntry,
  amount: bigint,
  daily: bigint,
  log: (message: string) => void,
): boolean {
  const text = readOrEmpty(dayFile(dir, entry.day));
  const spent = sum(text, dayFile(dir, entry.day), entry.payer, log).get(entry.asset) ?? 0n;
  if (spent + amount > daily) return false;
  append(dir, entry, amount, log);
  return true;
}

/**
 * Gives back an amount counted on `entry` whose payment was never signed: a negative line in the
 * day it was counted on, even if that day is over (harmless, it is no longer read).
 */
export function refundDaily(
  dir: string,
  entry: DailyEntry,
  amount: bigint,
  log: (message: string) => void,
): void {
  append(dir, entry, -amount, log);
}

/** An absent file is a day with nothing spent. */
function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (missing(error)) return "";
    throw error;
  }
}

function append(
  dir: string,
  { day, payer, asset }: DailyEntry,
  amount: bigint,
  log: (message: string) => void,
): void {
  mkdirSync(dir, { recursive: true });
  // Read as well as append, so the file's last byte can be checked on this descriptor.
  const fd = openSync(dayFile(dir, day), "a+");
  try {
    // Decided now, not from an earlier read: a file ending without a newline ends in a cut line, and
    // an empty line after it closes it off, so it is still known as cut once not last (see `sum`).
    const { size } = fstatSync(fd);
    const lastByte = Buffer.alloc(1);
    if (size > 0) readSync(fd, lastByte, 0, 1, size - 1);
    const gap = size > 0 && lastByte.toString() !== "\n" ? "\n\n" : "";
    // One write of a line far below 4 KiB: appended whole, never mixed with another process's line.
    const line = `${gap}${JSON.stringify({ payer, asset, amount: amount.toString() })}\n`;
    const written = writeSync(fd, line);
    // A full disk or quota can write part of the line and still return; that amount is not counted.
    if (written !== Buffer.byteLength(line)) {
      throw new Error(
        `wrote ${written} of ${Buffer.byteLength(line)} bytes to ${dayFile(dir, day)}`,
      );
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  removeOldDays(dir, day, log);
}

/** Deletes day files older than KEEP_DAYS. Housekeeping only: a failure is logged, never fatal. */
function removeOldDays(dir: string, today: string, log: (message: string) => void) {
  const oldest = utcDay(new Date(Date.parse(today) - KEEP_DAYS * 86_400_000));
  try {
    for (const name of readdirSync(dir)) {
      const day = /^spent-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (day === undefined || day >= oldest) continue;
      try {
        unlinkSync(join(dir, name));
      } catch (error) {
        // Another process deleted it first.
        if (!missing(error)) throw error;
      }
    }
  } catch (error) {
    log(`daily budget: could not delete old day files in ${dir} (${String(error)})`);
  }
}
