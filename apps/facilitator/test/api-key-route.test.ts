import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { apiKeyHash, newApiKey } from "../src/http/api-key.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { ApiKeyStore, RateLimitStore, Stores } from "../src/ports/index.js";
import type { Settle } from "../src/settlement/settle.js";
import type { Verify } from "../src/settlement/verify.js";
import { start, type Started } from "../src/start.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";

const db = testDatabase();
beforeEach(db.empty);

let app: Started | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Network = "stellar:pubnet" | "stellar:testnet";
type Route = "/verify" | "/settle";

/** A request that passes the body checks and names `network`. */
function payment(network: Network) {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amount: "1000",
    payTo: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
    maxTimeoutSeconds: 60,
    extra: {},
  };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
    paymentRequirements: requirements,
  };
}

/**
 * A facilitator with a budget of 2 a window on `/verify` and `/settle`, whose verifier and settler
 * are spies, and spies over the store calls a request can make before it is let in. `parseConfig`
 * refuses `stellar:pubnet` until the tasks its message names land, so a process that serves pubnet
 * gets the network set on the parsed config.
 */
async function serve(network: Network, env: Record<string, string> = {}) {
  const config = {
    ...parseConfig({
      ...signerEnv(Keypair.random().publicKey()),
      DATABASE_URL: db.urlFor(db.schema),
      CLIENT_IP: "socket",
      CHANNELS: Keypair.random().publicKey(),
      PORT: "0",
      RATE_LIMIT_VERIFY: "2",
      RATE_LIMIT_SETTLE: "2",
      RATE_LIMIT_WINDOW_MS: "3600000",
      ...env,
    }),
    network,
  };
  const real = db.stores();
  const hit = vi.fn<RateLimitStore["hit"]>((...args) => real.rateLimits.hit(...args));
  const ownerOf = vi.fn<ApiKeyStore["ownerOf"]>((hash) => real.apiKeys.ownerOf(hash));
  const stores: Stores = {
    ...real,
    rateLimits: { hit, prune: (...args) => real.rateLimits.prune(...args) },
    apiKeys: {
      ownerOf,
      issue: (key) => real.apiKeys.issue(key),
      revoke: (...args) => real.apiKeys.revoke(...args),
      list: () => real.apiKeys.list(),
    },
  };
  const verify = vi.fn<Verify>(async () => ({ isValid: true, payer: "GPAYER" }));
  const settle = vi.fn<Settle>(async () => ({
    response: { success: false, errorReason: "stub", transaction: "", network },
  }));
  const lines: string[] = [];
  app = await start({
    config,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics: memoryMetrics(),
    stores,
    verify,
    settle,
    extensionResponses: () => undefined,
    supported: supportedResponse(config.network, Keypair.random().publicKey()),
  });
  const url = `http://127.0.0.1:${app.port}`;
  const post = (
    route: Route,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  /** Issues `owner` a key, as the operator's script does, and resolves the key. */
  const issue = async (owner: string): Promise<string> => {
    const key = newApiKey();
    expect(await real.apiKeys.issue({ hash: apiKeyHash(key), owner, now: Date.now() })).toBe(true);
    return key;
  };
  const counters = async (): Promise<string[]> =>
    (await db.pool.query<{ key: string }>("SELECT key FROM rate_limits ORDER BY key")).rows.map(
      (row) => row.key,
    );
  const events = (event: string) =>
    lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === event);
  return { url, post, issue, counters, events, lines, hit, ownerOf, verify, settle, real };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const ROUTES: Route[] = ["/verify", "/settle"];

describe("API keys on stellar:pubnet (0105)", () => {
  describe.each(ROUTES)("POST %s without an active key", (route) => {
    it("answers 401 missing_api_key with no Authorization header, and nothing else happens", async () => {
      const { post, counters, hit, ownerOf, verify, settle } = await serve("stellar:pubnet");
      const response = await post(route, payment("stellar:pubnet"));
      expect([response.status, await response.json()]).toEqual([401, { error: "missing_api_key" }]);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(verify).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      // No counter, by key or by IP, and the registry isn't asked about a key that isn't there.
      expect(hit).not.toHaveBeenCalled();
      expect(ownerOf).not.toHaveBeenCalled();
      expect(await counters()).toEqual([]);
    });

    it("answers 401 invalid_api_key for a key the registry doesn't know", async () => {
      const { post, counters, hit, verify, settle, issue } = await serve("stellar:pubnet");
      await issue("operator:acme");
      const response = await post(route, payment("stellar:pubnet"), bearer(newApiKey()));
      expect([response.status, await response.json()]).toEqual([401, { error: "invalid_api_key" }]);
      expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
      expect(verify).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(hit).not.toHaveBeenCalled();
      expect(await counters()).toEqual([]);
    });

    it("answers 401 invalid_api_key for a revoked key, from the request after the revocation", async () => {
      const { post, counters, issue, real, verify, settle } = await serve("stellar:pubnet");
      const key = await issue("operator:acme");
      expect((await post(route, payment("stellar:pubnet"), bearer(key))).status).toBe(200);
      const letIn = verify.mock.calls.length + settle.mock.calls.length;
      const counted = await counters();
      expect(counted).toHaveLength(1);

      expect(await real.apiKeys.revoke("operator:acme", Date.now())).toBe(true);
      const response = await post(route, payment("stellar:pubnet"), bearer(key));
      expect([response.status, await response.json()]).toEqual([401, { error: "invalid_api_key" }]);
      expect(verify.mock.calls.length + settle.mock.calls.length).toBe(letIn);
      // The refused request counted nowhere.
      expect(await counters()).toEqual(counted);
      expect(
        (await db.pool.query<{ count: number }>("SELECT count FROM rate_limits")).rows,
      ).toEqual([{ count: 1 }]);
    });

    it.each([
      ["another scheme", "Basic dXNlcjpwYXNz"],
      ["a bare key", newApiKey()],
      ["a key without the prefix", `Bearer ${"k".repeat(48)}`],
      ["a key that is too short", "Bearer x402_short"],
      ["a key with characters outside base64url", `Bearer x402_${"+".repeat(43)}`],
      ["a key that is too long", `Bearer ${newApiKey()}A`],
      ["two keys", `Bearer ${newApiKey()} ${newApiKey()}`],
      ["a key's hash", `Bearer ${apiKeyHash(newApiKey())}`],
    ])("answers 401 invalid_api_key for %s without reading the registry", async (_name, value) => {
      const { post, counters, hit, ownerOf, verify, settle } = await serve("stellar:pubnet");
      const response = await post(route, payment("stellar:pubnet"), { authorization: value });
      expect([response.status, await response.json()]).toEqual([401, { error: "invalid_api_key" }]);
      expect(ownerOf).not.toHaveBeenCalled();
      expect(hit).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(await counters()).toEqual([]);
    });

    it("answers 500 and lets nothing in when the registry can't be read", async () => {
      const { post, issue, ownerOf, hit, verify, settle, events } = await serve("stellar:pubnet");
      const key = await issue("operator:acme");
      ownerOf.mockRejectedValueOnce(new Error("database down"));
      const response = await post(route, payment("stellar:pubnet"), bearer(key));
      expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
      expect(hit).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(events("http_error")).toHaveLength(1);
    });
  });

  describe("with an active key", () => {
    it("counts /verify under the key's owner, never the IP, and answers the verifier's verdict", async () => {
      // `cloudflare` with no `CF-Connecting-IP`: a request counted by IP would be a 500.
      const { post, issue, hit, counters, verify } = await serve("stellar:pubnet", {
        CLIENT_IP: "cloudflare",
      });
      const key = await issue("operator:acme");
      const response = await post("/verify", payment("stellar:pubnet"), bearer(key));
      expect([response.status, await response.json()]).toEqual([
        200,
        { isValid: true, payer: "GPAYER" },
      ]);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(hit).toHaveBeenCalledWith("verify:key:operator:acme", 3_600_000, expect.any(Number));
      expect(await counters()).toEqual(["verify:key:operator:acme"]);
    });

    it("counts /settle under the key's owner and hands the owner to the settler", async () => {
      const { post, issue, counters, settle } = await serve("stellar:pubnet");
      const key = await issue("discord:412345678901234567");
      const request = payment("stellar:pubnet");
      expect((await post("/settle", request, bearer(key))).status).toBe(200);
      expect(await counters()).toEqual(["settle:key:discord:412345678901234567"]);
      expect(settle).toHaveBeenCalledTimes(1);
      const [payload, requirements, signal, caller] = settle.mock.calls[0]!;
      expect(payload).toEqual(request.paymentPayload);
      expect(requirements).toEqual(request.paymentRequirements);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(caller).toEqual({ owner: "discord:412345678901234567" });
    });

    it("answers 429 past the owner's budget wherever its requests come from, and another owner goes on", async () => {
      const { post, issue, events } = await serve("stellar:pubnet", { CLIENT_IP: "cloudflare" });
      const acme = await issue("operator:acme");
      const other = await issue("operator:other");
      const from = (key: string, ip: string) =>
        post("/verify", payment("stellar:pubnet"), { ...bearer(key), "cf-connecting-ip": ip });
      expect((await from(acme, "203.0.113.7")).status).toBe(200);
      expect((await from(acme, "203.0.113.8")).status).toBe(200);
      const limited = await from(acme, "203.0.113.9");
      expect([limited.status, await limited.json()]).toEqual([429, { error: "too_many_requests" }]);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      // Sellers behind one address, as on Cloudflare Workers (0060), don't share a budget.
      expect((await from(other, "203.0.113.7")).status).toBe(200);
      expect(events("rate_limited")).toEqual([
        expect.objectContaining({ route: "verify", owner: "operator:acme", limit: 2 }),
      ]);
    });

    it("keeps an owner's count when its key is replaced, so a new key is no new budget", async () => {
      const { post, issue, real } = await serve("stellar:pubnet");
      const first = await issue("operator:acme");
      for (let i = 0; i < 2; i++)
        expect((await post("/verify", payment("stellar:pubnet"), bearer(first))).status).toBe(200);
      await real.apiKeys.revoke("operator:acme", Date.now());
      const second = await issue("operator:acme");
      expect((await post("/verify", payment("stellar:pubnet"), bearer(second))).status).toBe(429);
      // The revoked key gets the 401, not the 429: it isn't the owner's any more.
      expect((await post("/verify", payment("stellar:pubnet"), bearer(first))).status).toBe(401);
    });

    it("counts a request whose body fails the checks under the owner too", async () => {
      const { post, issue, counters, verify } = await serve("stellar:pubnet");
      const key = await issue("operator:acme");
      const broken = { ...payment("stellar:pubnet"), x402Version: 1 };
      for (const status of [400, 400, 429])
        expect((await post("/verify", broken, bearer(key))).status).toBe(status);
      expect(verify).not.toHaveBeenCalled();
      expect(await counters()).toEqual(["verify:key:operator:acme"]);
    });

    it.each(["bearer", "BEARER", "Bearer  "])("takes the scheme written as %j", async (scheme) => {
      const { post, issue } = await serve("stellar:pubnet");
      const key = await issue("operator:acme");
      const response = await post("/verify", payment("stellar:pubnet"), {
        authorization: `${scheme} ${key}`,
      });
      expect(response.status).toBe(200);
    });

    it("logs the owner with the verdict and the outcome, and never the key or its hash", async () => {
      const { post, issue, events, lines } = await serve("stellar:pubnet");
      const key = await issue("operator:acme");
      await post("/verify", payment("stellar:pubnet"), bearer(key));
      await post("/settle", payment("stellar:pubnet"), bearer(key));
      // Past the budget of 2, and a key nobody has: neither may log what was sent.
      await post("/verify", payment("stellar:pubnet"), bearer(key));
      await post("/verify", payment("stellar:pubnet"), bearer(key));
      const unknown = newApiKey();
      await post("/verify", payment("stellar:pubnet"), bearer(unknown));
      expect(events("verified")[0]).toMatchObject({ caller: "operator:acme" });
      expect(events("settled")[0]).toMatchObject({ caller: "operator:acme" });
      const logged = lines.join("\n");
      for (const secret of [key, unknown, apiKeyHash(key), apiKeyHash(unknown)])
        expect(logged).not.toContain(secret);
    });
  });

  it("requires the key by the network the request names, on a process that serves testnet too", async () => {
    const { post, verify } = await serve("stellar:testnet");
    const response = await post("/verify", payment("stellar:pubnet"));
    expect([response.status, await response.json()]).toEqual([401, { error: "missing_api_key" }]);
    expect(verify).not.toHaveBeenCalled();
  });

  it("takes the key from upstream's HTTPFacilitatorClient through createAuthHeaders, so a seller patches nothing", async () => {
    const { url, issue, verify, settle } = await serve("stellar:pubnet");
    const key = await issue("operator:acme");
    const { paymentPayload, paymentRequirements } = payment("stellar:pubnet");
    const headers = { Authorization: `Bearer ${key}` };
    const keyed = new HTTPFacilitatorClient({
      url,
      createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
    });
    expect(await keyed.verify(paymentPayload, paymentRequirements)).toEqual({
      isValid: true,
      payer: "GPAYER",
    });
    expect(await keyed.settle(paymentPayload, paymentRequirements)).toMatchObject({
      success: false,
      errorReason: "stub",
    });
    expect(settle.mock.calls[0]![3]).toEqual({ owner: "operator:acme" });
    // `/supported` stays open, and a key sent to it is ignored.
    expect((await keyed.getSupported()).kinds.length).toBeGreaterThan(0);

    // The same client without the hook: its error carries our status and reason to the seller.
    const keyless = new HTTPFacilitatorClient({ url });
    await expect(keyless.verify(paymentPayload, paymentRequirements)).rejects.toThrow(
      /401.*missing_api_key/,
    );
    await expect(keyless.settle(paymentPayload, paymentRequirements)).rejects.toThrow(
      /401.*missing_api_key/,
    );
    expect((await keyless.getSupported()).kinds.length).toBeGreaterThan(0);
    expect([verify.mock.calls.length, settle.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("stellar:testnet takes no API key (0105)", () => {
  // The process that serves testnet today, and one that serves pubnet as well (0126).
  describe.each<Network>(["stellar:testnet", "stellar:pubnet"])("on a %s process", (served) => {
    describe.each(ROUTES)("POST %s", (route) => {
      it("answers with no key, a made-up key and a registered one alike, counted by IP", async () => {
        const { post, issue, hit, ownerOf, counters, verify, settle } = await serve(served, {
          RATE_LIMIT_VERIFY: "10",
          RATE_LIMIT_SETTLE: "10",
        });
        const registered = await issue("operator:acme");
        const headers: Record<string, string>[] = [
          {},
          bearer(newApiKey()),
          bearer(registered),
          { authorization: "Basic dXNlcjpwYXNz" },
          { authorization: "Bearer not-a-key" },
        ];
        const answers = [];
        for (const sent of headers) {
          const response = await post(route, payment("stellar:testnet"), sent);
          answers.push([response.status, await response.text()]);
        }
        // One answer for all five: the stub's, as before this task.
        expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
        expect(answers[0]![0]).toBe(200);
        expect(verify.mock.calls.length + settle.mock.calls.length).toBe(headers.length);
        // The header is never read: no registry call, and every request counts under the IP.
        expect(ownerOf).not.toHaveBeenCalled();
        const name = route.slice(1);
        expect(await counters()).toEqual([expect.stringMatching(new RegExp(`^${name}:ip:`))]);
        expect(hit).toHaveBeenCalledTimes(headers.length);
        // The settler gets no caller, so the spend policy budgets as before.
        for (const call of settle.mock.calls) expect(call[3]).toBeUndefined();
      });

      it("answers 429 past the IP's budget, whatever key each request carries", async () => {
        const { post, issue } = await serve(served);
        const keys = [await issue("operator:a"), await issue("operator:b"), newApiKey()];
        const statuses = [];
        for (const key of keys)
          statuses.push((await post(route, payment("stellar:testnet"), bearer(key))).status);
        expect(statuses).toEqual([200, 200, 429]);
      });
    });
  });

  it.each([
    ["JSON that doesn't parse", "{", 400],
    ["a body that names no network", "{}", 400],
    ["a body that isn't an object", "[]", 400],
    ["requirements that aren't an object", '{"paymentRequirements":"stellar:pubnet"}', 400],
    [
      "a network that isn't a string",
      '{"paymentRequirements":{"network":["stellar:pubnet"]}}',
      400,
    ],
    ["a body over the size limit", JSON.stringify({ pad: "x".repeat(70_000) }), 413],
  ])("counts %s by IP and answers as before, key or no key", async (_name, body, status) => {
    const { post, issue, ownerOf, counters } = await serve("stellar:pubnet");
    const key = await issue("operator:acme");
    const statuses = [];
    for (const headers of [{}, bearer(key), bearer(newApiKey())])
      statuses.push((await post("/verify", body, headers)).status);
    expect(statuses).toEqual([status, status, 429]);
    expect(ownerOf).not.toHaveBeenCalled();
    expect(await counters()).toEqual([expect.stringMatching(/^verify:ip:/)]);
  });
});
