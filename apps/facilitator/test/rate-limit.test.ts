import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, memoryStores } from "../src/adapters/memory.js";
import { parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";
import type { RateLimitStore, Stores } from "../src/ports/index.js";

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
async function serve(env: Record<string, string> = {}, stores: Stores = memoryStores()) {
  const config = parseConfig({
    FACILITATOR_SECRET: Keypair.random().secret(),
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

/** A rate-limit store whose `hit` is a spy over the memory one. */
function spiedStores(): { stores: Stores; hit: ReturnType<typeof vi.fn<RateLimitStore["hit"]>> } {
  const memory = new MemoryRateLimitStore();
  const hit = vi.fn<RateLimitStore["hit"]>((...args) => memory.hit(...args));
  return { stores: { ...memoryStores(), rateLimits: { hit } }, hit };
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
    expect((await fetch(`${url}/discovery/resources`)).status).toBe(501);
    expect((await fetch(`${url}/discovery/resources`)).status).toBe(501);
    expect((await fetch(`${url}/discovery/resources`)).status).toBe(429);
    expect((await fetch(`${url}/discovery/search`)).status).toBe(429);
  });

  it("ignores X-Forwarded-For: without CLIENT_IP_HEADER the client is the socket address", async () => {
    const { post } = await serve();
    const forged = ["1.2.3.4", "5.6.7.8", "9.9.9.9"];
    const statuses = [];
    for (const ip of forged)
      statuses.push((await post("/settle", { "x-forwarded-for": ip })).status);
    expect(statuses).toEqual([400, 400, 429]);
  });

  it("keys the client by CLIENT_IP_HEADER, never by X-Forwarded-For", async () => {
    const { post } = await serve({ CLIENT_IP_HEADER: "cf-connecting-ip" });
    const from = (ip: string, forwarded: string) =>
      post("/verify", { "cf-connecting-ip": ip, "x-forwarded-for": forwarded });
    expect((await from("203.0.113.7", "1.1.1.1")).status).toBe(400);
    expect((await from("203.0.113.7", "2.2.2.2")).status).toBe(400);
    expect((await from("203.0.113.7", "3.3.3.3")).status).toBe(429);
    expect((await from("203.0.113.8", "3.3.3.3")).status).toBe(400);
  });

  it("counts IPv6 clients per /56, so one /64 can't rotate past the budget", async () => {
    const { post } = await serve({ CLIENT_IP_HEADER: "cf-connecting-ip" });
    const from = (ip: string) => post("/verify", { "cf-connecting-ip": ip });
    expect((await from("2001:db8:0:1::1")).status).toBe(400);
    expect((await from("2001:db8:0:2::9")).status).toBe(400);
    expect((await from("2001:db8:0:ff::5")).status).toBe(429);
    expect((await from("2001:db8:0:100::1")).status).toBe(400);
  });

  it("answers 500 and logs it when the configured header is missing", async () => {
    const { lines, post } = await serve({ CLIENT_IP_HEADER: "cf-connecting-ip" });
    const response = await post("/verify");
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "client_ip_missing", header: "cf-connecting-ip" }),
    );
  });

  it("answers 500 and logs the cause when the store fails", async () => {
    const failing: RateLimitStore = {
      hit: async () => {
        throw new Error("database down");
      },
    };
    const { lines, post } = await serve({}, { ...memoryStores(), rateLimits: failing });
    const response = await post("/settle");
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.join("")).toContain("http_error");
    expect(lines.join("")).toContain("database down");
  });

  it("answers a client over budget from memory, so its flood never reaches the store", async () => {
    const { stores, hit } = spiedStores();
    const { lines, post } = await serve({ CLIENT_IP_HEADER: "cf-connecting-ip" }, stores);
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

  it("hands the store the route, the client and the configured window", async () => {
    const { stores, hit } = spiedStores();
    const { post } = await serve(
      { CLIENT_IP_HEADER: "cf-connecting-ip", RATE_LIMIT_WINDOW_MS: "5000" },
      stores,
    );
    await post("/settle", { "cf-connecting-ip": "203.0.113.7" });
    expect(hit).toHaveBeenCalledWith("settle:ip:203.0.113.7", 5_000, expect.any(Number));
  });
});
