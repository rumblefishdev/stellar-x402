import { createHash } from "node:crypto";
import type { CatalogKey, RateLimitStore } from "../ports/index.js";

const WINDOW_MS = 60_000;

/** Seller checks allowed a minute to one host (0063, an assumption). */
export const CHECKS_PER_HOST = 30;

/**
 * The budget a seller check would go over, or `undefined` when it may run (0063): one check a
 * minute per listing key, so a busy listing leaves the host's budget to new ones, then
 * `checksPerHost` a minute to its host. No budget spans hosts: one busy host never holds back
 * another's checks. Counted in the shared rate-limit store, so every facilitator process keeps the
 * same budget. A check the host budget refuses still uses its key's minute; both windows end
 * together, so a later payment that minute would meet the full host budget anyway.
 */
export async function overBudget(
  rateLimits: Pick<RateLimitStore, "hit">,
  key: CatalogKey,
  host: string,
  checksPerHost: number,
  now: number,
): Promise<"key" | "host" | undefined> {
  // Hashed: a key carries a URL of up to 2,048 characters.
  const id = createHash("sha256").update(JSON.stringify(key)).digest("hex");
  if ((await rateLimits.hit(`catalog:key:${id}`, WINDOW_MS, now)).count > 1) return "key";
  if ((await rateLimits.hit(`catalog:host:${host}`, WINDOW_MS, now)).count > checksPerHost)
    return "host";
  return undefined;
}
