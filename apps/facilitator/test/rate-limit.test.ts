import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";
import { rateLimit } from "../src/http/rate-limit.js";
import { memoryMetrics } from "../src/metrics.js";
import type { RateLimitStore, Stores } from "../src/ports/index.js";
import { testDatabase } from "./database.js";

const db = testDatabase();
beforeEach(db.empty);

let app: Started | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * A facilitator with a budget of 2 on each limited route; `/verify` and `/settle` are stubs. Windows
 * are aligned to the clock, so a test's requests share one only if no boundary falls between them:
 * an hour's window makes that all but certain.
 */
async function serve(env: Record<string, string> = {}, stores: Stores = db.stores()) {
  const config = parseConfig({
    FACILITATOR_SECRET: Keypair.random().secret(),
    DATABASE_URL: db.urlFor(db.schema),
    CLIENT_IP: "socket",
    CHANNELS: Keypair.random().publicKey(),
    PORT: "0",
    RATE_LIMIT_VERIFY: "2",
    RATE_LIMIT_SETTLE: "2",
    RATE_LIMIT_DISCOVERY: "2",
    RATE_LIMIT_WINDOW_MS: "3600000",
    ...env,
  });
  const lines: string[] = [];
  app = await start({
    config,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics: memoryMetrics(),
    stores,
    verify: async () => ({ isValid: true }),
    settle: async () => ({
      response: { success: false, transaction: "", network: config.network },
    }),
    extensionResponses: () => undefined,
    supported: supportedResponse(config.network, Keypair.random().publicKey()),
  });
  const url = `http://127.0.0.1:${app.port}`;
  /** A POST of an empty object: a 400, which counts like any other request. */
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
  return { url, lines, post };
}

/** A rate-limit store whose `hit` is a spy over the database one. */
function spiedStores(): { stores: Stores; hit: ReturnType<typeof vi.fn<RateLimitStore["hit"]>> } {
  const stores = db.stores();
  const hit = vi.fn<RateLimitStore["hit"]>((...args) => stores.rateLimits.hit(...args));
  const prune: RateLimitStore["prune"] = (...args) => stores.rateLimits.prune(...args);
  return { stores: { ...stores, rateLimits: { hit, prune } }, hit };
}

describe("the rate limiter", () => {
  it("answers 429 with Retry-After past a route's budget, on that route only", async () => {
    const { url, post } = await serve();
    expect((await post("/verify")).status).toBe(400);
    expect((await post("/verify")).status).toBe(400);
    const limited = await post("/verify");
    expect([limited.status, await limited.json()]).toEqual([429, { error: "too_many_requests" }]);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    // No counting headers: upstream's client reads only Retry-After.
    expect(limited.headers.get("x-ratelimit-limit")).toBeNull();
    expect(limited.headers.get("ratelimit")).toBeNull();

    expect((await post("/settle")).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await fetch(`${url}/supported`)).status).toBe(200);
  });

  it("limits /discovery/* with its own budget", async () => {
    const { url } = await serve();
    expect((await fetch(`${url}/discovery/resources`)).status).toBe(200);
    expect((await fetch(`${url}/discovery/resources`)).status).toBe(200);
    expect((await fetch(`${url}/discovery/resources`)).status).toBe(429);
    expect((await fetch(`${url}/discovery/search`)).status).toBe(429);
  });

  it("ignores X-Forwarded-For: with CLIENT_IP=socket the client is the connection's address", async () => {
    const { post } = await serve();
    const forged = ["1.2.3.4", "5.6.7.8", "9.9.9.9"];
    const statuses = [];
    for (const ip of forged)
      statuses.push((await post("/settle", { "x-forwarded-for": ip })).status);
    expect(statuses).toEqual([400, 400, 429]);
  });

  it("keys the client by CF-Connecting-IP with CLIENT_IP=cloudflare, never by X-Forwarded-For", async () => {
    const { post } = await serve({ CLIENT_IP: "cloudflare" });
    const from = (ip: string, forwarded: string) =>
      post("/verify", { "cf-connecting-ip": ip, "x-forwarded-for": forwarded });
    expect((await from("203.0.113.7", "1.1.1.1")).status).toBe(400);
    expect((await from("203.0.113.7", "2.2.2.2")).status).toBe(400);
    expect((await from("203.0.113.7", "3.3.3.3")).status).toBe(429);
    expect((await from("203.0.113.8", "3.3.3.3")).status).toBe(400);
  });

  it("counts IPv6 clients per /56, so one /64 can't rotate past the budget", async () => {
    const { post } = await serve({ CLIENT_IP: "cloudflare" });
    const from = (ip: string) => post("/verify", { "cf-connecting-ip": ip });
    expect((await from("2001:db8:0:1::1")).status).toBe(400);
    expect((await from("2001:db8:0:2::9")).status).toBe(400);
    expect((await from("2001:db8:0:ff::5")).status).toBe(429);
    expect((await from("2001:db8:0:100::1")).status).toBe(400);
  });

  it("answers 500 and logs it when the configured header is missing", async () => {
    const { lines, post } = await serve({ CLIENT_IP: "cloudflare" });
    const response = await post("/verify");
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "client_ip_missing", source: "cloudflare" }),
    );
  });

  it("answers 500 without a store hit when the header holds anything but one address", async () => {
    const { stores, hit } = spiedStores();
    const { lines, post } = await serve({ CLIENT_IP: "cloudflare" }, stores);
    // A header sent twice arrives joined; a value this long wouldn't fit the store's key index.
    for (const value of ["203.0.113.7, 203.0.113.8", "a".repeat(8_000), "localhost"]) {
      const response = await post("/verify", { "cf-connecting-ip": value });
      expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    }
    expect(hit).not.toHaveBeenCalled();
    const invalid = lines
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === "client_ip_invalid");
    expect(invalid).toHaveLength(3);
    // The value is the caller's, so the log never carries it.
    expect(lines.join("")).not.toContain("aaaa");
  });

  it("answers 500 and logs the cause when the store fails", async () => {
    const failing: RateLimitStore = {
      hit: async () => {
        throw new Error("database down");
      },
      prune: async () => 0,
    };
    const { lines, post } = await serve({}, { ...db.stores(), rateLimits: failing });
    const response = await post("/settle");
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.join("")).toContain("http_error");
    expect(lines.join("")).toContain("database down");
  });

  it("answers a client over budget from memory, so its flood never reaches the store", async () => {
    const { stores, hit } = spiedStores();
    const { lines, post } = await serve({ CLIENT_IP: "cloudflare" }, stores);
    const from = (ip: string) => post("/verify", { "cf-connecting-ip": ip });
    for (let i = 0; i < 2; i++) expect((await from("203.0.113.7")).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await from("203.0.113.7")).status).toBe(429);
    // The two within budget, and the one that found it spent.
    expect(hit).toHaveBeenCalledTimes(3);
    expect((await from("203.0.113.8")).status).toBe(400);
    expect(hit).toHaveBeenCalledTimes(4);

    // One line per client and window, not one per refused request.
    const limited = lines.map((line) => JSON.parse(line)).filter((e) => e.event === "rate_limited");
    expect(limited).toEqual([
      expect.objectContaining({ route: "verify", client: "203.0.113.7", limit: 2 }),
    ]);
  });

  it("logs one rate_limited line for a burst of requests already in flight", async () => {
    // A store that answers 20 ms later, so every request is in flight at once.
    const stores = db.stores();
    const slow: RateLimitStore = {
      hit: async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return stores.rateLimits.hit(...args);
      },
      prune: (...args) => stores.rateLimits.prune(...args),
    };
    const { lines, post } = await serve(
      { CLIENT_IP: "cloudflare" },
      { ...stores, rateLimits: slow },
    );
    const burst = await Promise.all(
      Array.from({ length: 20 }, () => post("/verify", { "cf-connecting-ip": "203.0.113.7" })),
    );
    expect(burst.filter((response) => response.status === 429)).toHaveLength(18);
    const limited = lines.map((line) => JSON.parse(line)).filter((e) => e.event === "rate_limited");
    expect(limited).toHaveLength(1);
  });

  it("logs the full address next to the /56 it counts for an IPv6 client", async () => {
    const { lines, post } = await serve({ CLIENT_IP: "cloudflare" });
    for (let i = 0; i < 3; i++) await post("/verify", { "cf-connecting-ip": "2001:db8:0:1::7" });
    const limited = lines.map((line) => JSON.parse(line)).filter((e) => e.event === "rate_limited");
    expect(limited).toEqual([
      expect.objectContaining({ ip: "2001:db8:0:1::7", client: "2001:db8::/56" }),
    ]);
  });

  it("counts a body over the size limit like any other request", async () => {
    const { url } = await serve({ BODY_LIMIT_BYTES: "1024" });
    const big = () =>
      fetch(`${url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(2_000) }),
      });
    expect((await big()).status).toBe(413);
    expect((await big()).status).toBe(413);
    expect((await big()).status).toBe(429);
  });

  it("hands the store the route, the client and the configured window", async () => {
    const { stores, hit } = spiedStores();
    const { post } = await serve({ CLIENT_IP: "cloudflare", RATE_LIMIT_WINDOW_MS: "5000" }, stores);
    await post("/settle", { "cf-connecting-ip": "203.0.113.7" });
    expect(hit).toHaveBeenCalledWith("settle:ip:203.0.113.7", 5_000, expect.any(Number));
  });

  it("lets a client through again once its window ends, and logs it again when it is over", async () => {
    let clock = 0;
    const lines: string[] = [];
    const limited = express().use(
      rateLimit({
        route: "verify",
        limit: 2,
        windowMs: 60_000,
        clientIp: "socket",
        store: db.stores().rateLimits,
        logger: jsonLogger("debug", (line) => lines.push(line)),
        now: () => clock,
      }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    const server = limited.listen(0);
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const statuses = async (count: number) => {
      const seen = [];
      for (let i = 0; i < count; i++) seen.push((await fetch(url)).status);
      return seen;
    };
    try {
      expect(await statuses(3)).toEqual([200, 200, 429]);
      // Still the same window: answered from the process, not counted again.
      clock = 59_999;
      expect(await statuses(1)).toEqual([429]);
      // The next window: a fresh budget, and a second rate_limited line when it runs out.
      clock = 60_000;
      expect(await statuses(3)).toEqual([200, 200, 429]);
      const logged = lines
        .map((line) => JSON.parse(line))
        .filter((e) => e.event === "rate_limited");
      expect(logged).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});
