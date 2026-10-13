import { readFileSync } from "node:fs";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  log: (message: string) => void,
): Promise<boolean> {
  return locked(file, log, async () => {
    const days = parse(await readOrNothing(file), file);
    const already = BigInt(days[day]?.[asset] ?? "0");
    if (already + amount > daily) return false;
    await replace(file, { [day]: { ...days[day], [asset]: (already + amount).toString() } });
    return true;
  });
}

/**
 * Gives back an amount counted on `day` whose payment was never signed. A day already dropped is over,
 * so nothing is given back to it; like a count, the write keeps only `day`.
 */
export async function refundDaily(
  file: string,
  day: string,
  asset: string,
  amount: bigint,
  log: (message: string) => void,
): Promise<void> {
  await locked(file, log, async () => {
    const days = parse(await readOrNothing(file), file);
    if (days[day] === undefined) return;
    const already = BigInt(days[day][asset] ?? "0");
    if (already < amount) {
      // Something else changed the record since this amount was counted: leave it as it is.
      log(`daily budget: cannot give back ${amount} of ${asset}, the record holds only ${already}`);
      return;
    }
    await replace(file, { [day]: { ...days[day], [asset]: (already - amount).toString() } });
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
 * a process that died is taken over once it is older than STALE_LOCK_MS.
 */
async function locked<T>(
  file: string,
  log: (message: string) => void,
  work: () => Promise<T>,
): Promise<T> {
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
      await removeIfStale(lock);
    } catch (error) {
      // Its holder, or another waiter, removed it first: try again.
      if (!missing(error)) throw error;
    }
    if (Date.now() > giveUp) throw new Error(`${lock} is held by another process`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await work();
  } finally {
    await release(lock, log);
  }
}

async function release(lock: string, log: (message: string) => void): Promise<void> {
  try {
    await unlink(lock);
  } catch (error) {
    if (!missing(error)) throw error;
    // Another process took our lock over as stale; what `work` did is done and stays done.
    log(`daily budget: ${lock} was already gone when its holder released it`);
  }
}

/**
 * Removes `lock` if it is older than STALE_LOCK_MS. Two waiters can both find it stale, and between
 * their checks one of them may already hold a fresh lock under the same name. So the lock is first
 * renamed to a name only this process uses: one rename wins, and the file it took is checked to be
 * the same stale one before it is deleted; a fresh lock taken by mistake is put back.
 */
async function removeIfStale(lock: string): Promise<void> {
  const seen = await stat(lock);
  if (Date.now() - seen.mtimeMs <= STALE_LOCK_MS) return;
  const taken = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  await rename(lock, taken);
  try {
    const got = await stat(taken);
    if (got.ino !== seen.ino || got.dev !== seen.dev) {
      // Another waiter already removed the stale lock and holds a fresh one. `link` puts it back
      // and fails, loudly, rather than replace a lock a third process created in that instant.
      await link(taken, lock);
    }
  } finally {
    await unlink(taken);
  }
}
