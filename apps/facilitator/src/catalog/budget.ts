import { createHash } from "node:crypto";
import type { CatalogKey, RateLimitStore } from "../ports/index.js";

const WINDOW_MS = 60_000;

/** Seller checks allowed a minute: to one host, and over all hosts (0063, both assumptions). */
export interface ChecksPerMinute {
  host: number;
  all: number;
}

export const CHECKS_PER_MINUTE: ChecksPerMinute = { host: 30, all: 300 };

/**
 * The budget a seller check would go over, or `undefined` when it may run (0063): one check a
 * minute per listing key, so a busy listing leaves the host's budget to new ones, then `limits`.
 * Counted in the shared rate-limit store, so every facilitator process keeps the same budget; a
 * check refused by one budget doesn't count against the next.
 */
export async function overBudget(
  rateLimits: Pick<RateLimitStore, "hit">,
  key: CatalogKey,
  host: string,
  limits: ChecksPerMinute,
  now: number,
): Promise<"key" | "host" | "all" | undefined> {
  // Hashed: a key carries a URL of up to 2,048 characters.
  const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
  if ((await rateLimits.hit(`catalog:key:${id}`, WINDOW_MS, now)).count > 1) return "key";
  if ((await rateLimits.hit(`catalog:host:${host}`, WINDOW_MS, now)).count > limits.host)
    return "host";
  if ((await rateLimits.hit("catalog:all", WINDOW_MS, now)).count > limits.all) return "all";
  return undefined;
}
