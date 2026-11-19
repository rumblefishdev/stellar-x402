import { rfc3339 } from "./cap.js";

/** The first millisecond a Discord id can name: every id carries its creation time from here. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** When the account with this id was created, in Unix milliseconds: the id's top 42 bits. */
export function accountCreatedMs(id: string): number | undefined {
  if (!/^[0-9]{1,20}$/.test(id)) return undefined;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/**
 * Whether the account is old enough for a key, and if not, when it will be: a Discord account
 * made a minute ago is how a script farms keys. `undefined` is an id that isn't a snowflake.
 */
export function accountAge(
  id: string,
  minAccountAgeMinutes: number,
  nowMs: number,
): { kind: "old_enough" } | { kind: "too_young"; oldEnoughAt: string } | undefined {
  const created = accountCreatedMs(id);
  if (created === undefined) return undefined;
  // No minimum, nothing to wait for: not even for an id stamped after now (a skewed clock).
  if (minAccountAgeMinutes === 0) return { kind: "old_enough" };
  const oldEnoughAt = created + minAccountAgeMinutes * 60_000;
  if (nowMs >= oldEnoughAt) return { kind: "old_enough" };
  // Rounded up, so the time we tell is never one the account would still be refused at.
  return { kind: "too_young", oldEnoughAt: rfc3339(Math.ceil(oldEnoughAt / 1000) * 1000) };
}
