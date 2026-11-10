import { isIP } from "node:net";
import type { RequestHandler } from "express";
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
 * One route's budget (AD-11): a fixed window per client, counted in `RateLimitStore`, and a 429
 * past it. Every request counts, a malformed one too. An IPv6 client is counted per /56, so one
 * /64 can't rotate past the budget. A store error fails the request with a 500.
 *
 * A client over its budget is remembered in the process until its window ends and answered
 * without a store hit, so its flood can't hold the store's few connections from everyone else.
 */
export function rateLimit({
  route,
  limit,
  windowMs,
  clientIp,
  store,
  logger,
  now: clock = Date.now,
}: RateLimit): RequestHandler {
  /** Clients over budget, with the end of their window in milliseconds since the epoch. */
  const blocked = new Map<string, number>();

  return async (req, res, next) => {
    const ip = clientIp === "cloudflare" ? req.get("cf-connecting-ip") : req.socket.remoteAddress;
    if (!ip || isIP(ip) === 0) {
      // Only `cloudflared` reaches the service, and Cloudflare sets the header to one address on
      // every request. Anything else never reaches the store; the value is the caller's, so it isn't
      // logged.
      logger.error(ip ? "client_ip_invalid" : "client_ip_missing", {
        route,
        source: clientIp,
      });
      res.status(500).json({ error: "internal_error" });
      return;
    }
    const client = ipKeyGenerator(ip);
    const now = clock();

    let resetAt = blocked.get(client);
    if (resetAt === undefined || resetAt <= now) {
      // A store error rejects, and Express answers it with a 500.
      const hit = await store.hit(`${route}:ip:${client}`, windowMs, now);
      if (hit.count <= limit) {
        next();
        return;
      }
      resetAt = hit.resetAt;
      // Requests already in flight find the budget spent too; only the first one logs.
      const logged = (blocked.get(client) ?? 0) > now;
      for (const [key, end] of blocked) if (end <= now) blocked.delete(key);
      blocked.set(client, resetAt);
      // `ip` is the address to block at the edge; `client` is what was counted (an IPv6 /56).
      if (!logged) logger.warn("rate_limited", { route, ip, client, limit, windowMs });
    }
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
    res.status(429).json({ error: "too_many_requests" });
  };
}
