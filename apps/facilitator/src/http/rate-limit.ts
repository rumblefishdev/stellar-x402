import { isIP } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import type { Logger } from "../logger.js";
import type { RateLimitStore } from "../ports/index.js";

export interface RateLimit {
  /** The route's name in the counter's key and the logs: `verify`, `settle`, `discovery`. */
  route: string;
  /** Requests per window and client. */
  limit: number;
  windowMs: number;
  /** `cloudflare`: the `CF-Connecting-IP` header; `socket`: the connection's own address. */
  clientIp: "cloudflare" | "socket";
  store: RateLimitStore;
  logger: Logger;
  now?: () => number;
}

/**
 * One route's budget (AD-11), counted for one client at a time. Each call counts the request and
 * resolves whether it may go on; when it may not, the call has answered it. A store error rejects.
 */
export interface RateLimiter {
  /**
   * Counts the request under its client's IP, as `<route>:ip:<address>`. An IPv6 client is counted
   * per /56, so one /64 can't rotate past the budget. Answers 500 when the configured source
   * gives no address.
   */
  byIp(req: Request, res: Response): Promise<boolean>;
  /**
   * Counts the request under an API key's owner (0105), as `<route>:key:<owner>`, wherever it
   * comes from. The count is the owner's, not the key's, so a new key carries it on.
   */
  byOwner(owner: string, res: Response): Promise<boolean>;
}

/**
 * A fixed window per client, counted in `RateLimitStore`, and a 429 past it. Every request counts,
 * a malformed one too.
 *
 * A client over its budget is remembered in the process until its window ends and answered
 * without a store hit, so its flood can't hold the store's few connections from everyone else.
 */
export function rateLimiter({
  route,
  limit,
  windowMs,
  clientIp,
  store,
  logger,
  now: clock = Date.now,
}: RateLimit): RateLimiter {
  /** Clients over budget, by counter key, with the end of their window in ms since the epoch. */
  const blocked = new Map<string, number>();

  /** `client` is `ip:<address>` or `key:<owner>`; `who` names it in the `rate_limited` log. */
  const count = async (
    client: string,
    who: Record<string, string>,
    res: Response,
  ): Promise<boolean> => {
    const now = clock();
    let resetAt = blocked.get(client);
    if (resetAt === undefined || resetAt <= now) {
      const hit = await store.hit(`${route}:${client}`, windowMs, now);
      if (hit.count <= limit) return true;
      resetAt = hit.resetAt;
      // Requests already in flight find the budget spent too; only the first one logs.
      const logged = (blocked.get(client) ?? 0) > now;
      for (const [key, end] of blocked) if (end <= now) blocked.delete(key);
      blocked.set(client, resetAt);
      if (!logged) logger.warn("rate_limited", { route, ...who, limit, windowMs });
    }
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
    res.status(429).json({ error: "too_many_requests" });
    return false;
  };

  return {
    async byIp(req, res) {
      const ip = clientIp === "cloudflare" ? req.get("cf-connecting-ip") : req.socket.remoteAddress;
      if (!ip || isIP(ip) === 0) {
        // Only `cloudflared` reaches the service, and Cloudflare sets the header to one address on
        // every request. Anything else never reaches the store; the value is the caller's, so it
        // isn't logged.
        logger.error(ip ? "client_ip_invalid" : "client_ip_missing", {
          route,
          source: clientIp,
        });
        res.status(500).json({ error: "internal_error" });
        return false;
      }
      const client = ipKeyGenerator(ip);
      // `ip` is the address to block at the edge; `client` is what was counted (an IPv6 /56).
      return count(`ip:${client}`, { ip, client }, res);
    },
    byOwner: (owner, res) => count(`key:${owner}`, { owner }, res),
  };
}

/** {@link RateLimiter.byIp} as a middleware, for a route whose every client is counted by IP. */
export function rateLimit(options: RateLimit): RequestHandler {
  const limiter = rateLimiter(options);
  // A store error rejects, and Express answers it with a 500.
  return async (req, res, next) => {
    if (await limiter.byIp(req, res)) next();
  };
}
