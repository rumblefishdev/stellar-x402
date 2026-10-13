import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * What was spent per UTC day and asset, in atomic units: `{"2026-10-13": {"C…": "20000"}}`. One file
 * is shared by every server process of a buyer, so a restart or a second Claude session does not
 * start the day again from zero. Only today's entry counts; older days are dropped on the next count.
 */
const SPENT = z.record(z.record(z.string().regex(/^\d+$/)));
type SpentDays = z.infer<typeof SPENT>;

/** The day a payment counts against: the UTC date, the same for every process whatever its zone. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** An absent file is a day with nothing spent; a file that cannot be read or parsed is an error. */
function parse(text: string | undefined, file: string): SpentDays {
  if (text === undefined) return {};
  const parsed = SPENT.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${file} is not a spent-per-day record`);
  return parsed.data;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Spent on `day` per asset, read without the lock: a write replaces the file whole, so a reader sees
 * the old or the new record, never half of one. Synchronous, for the library's offer filter.
 */
export function spentOn(file: string, day: string): Map<string, bigint> {
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const amounts = parse(text, file)[day] ?? {};
  return new Map(Object.entries(amounts).map(([asset, amount]) => [asset, BigInt(amount)]));
}

/**
 * Counts `amount` against `day` if it stays within `daily`; false when it would not. Runs under the
 * lock, so two processes paying at once cannot both fit in the last part of the budget.
 */
export async function countDaily(
  file: string,
  day: string,
  asset: string,
  amount: bigint,
  daily: bigint,
): Promise<boolean> {
  return locked(file, async () => {
    const days = parse(await readOrNothing(file), file);
    const already = BigInt(days[day]?.[asset] ?? "0");
    if (already + amount > daily) return false;
    await replace(file, { [day]: { ...days[day], [asset]: (already + amount).toString() } });
    return true;
  });
}

/** Gives back an amount counted on `day` whose payment was never signed. A day already dropped is over. */
export async function refundDaily(
  file: string,
  day: string,
  asset: string,
  amount: bigint,
): Promise<void> {
  await locked(file, async () => {
    const days = parse(await readOrNothing(file), file);
    const already = BigInt(days[day]?.[asset] ?? "0");
    if (already < amount) return;
    await replace(file, {
      ...days,
      [day]: { ...days[day], [asset]: (already - amount).toString() },
    });
  });
}

async function readOrNothing(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Writes beside the file, then renames over it: a reader never sees half a record. */
async function replace(file: string, days: SpentDays): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(days));
  await rename(temporary, file);
}

/** A lock held longer than this belongs to a process that died; the work under it takes milliseconds. */
const STALE_LOCK_MS = 5_000;
/** Waiting longer than a stale lock lives means something else is wrong. */
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;

/**
 * Runs `work` while holding `<file>.lock`, a file only one process can create (`wx`). A lock left by
 * a process that died is removed once it is older than STALE_LOCK_MS.
 */
async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) await unlink(lock);
    } catch (error) {
      // Its holder removed it between the two steps: try again.
      if (!missing(error)) throw error;
    }
    if (Date.now() > giveUp) throw new Error(`${lock} is held by another process`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await work();
  } finally {
    await unlink(lock);
  }
}
