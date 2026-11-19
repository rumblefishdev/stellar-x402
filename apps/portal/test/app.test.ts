import { apiKeyHash, isApiKey } from "@stellar-x402/api-keys";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_LIMIT_PER_MINUTE,
  HEALTH_WINDOW_MS,
  STRANGER_LIMIT_PER_MINUTE,
} from "../src/app.js";
import { ACTS, type Act } from "../src/hub-token.js";
import { sealer } from "../src/seal.js";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ENCRYPTION_KEY,
  NOW,
  ROUTES,
  SECRET,
  USERNAME,
  YOUNG_ACCOUNT,
  ownerOf,
  startPortal,
  type Portal,
} from "./portal.js";

// The other product's token: the same secret and claims, `aud: "prices"`, its own context.
const PRICES_TOKEN =
  "v1.eyJpc3MiOiJodHRwczovL3Nvcm9iYW5zY2FuLmNvbS9hcGkvaHViIiwiYXVkIjoicHJpY2VzIiwic3ViIjoiZGlzY29yZDo4MDM1MTExMDIyNDY3ODkxMiIsIm5hbWUiOiJuZWxseSIsImlhdCI6MTc5NTAwMDAwMCwiZXhwIjoxNzk1MDAwMDYwLCJqdGkiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3IiwiYWN0IjoicmV2ZWFsIn0.aeS9_nACshTGuf2Afv4wbQhvLR-f64XCX0OVmmngofE";

const OWNER_A = ownerOf(ACCOUNT_A);
const DAY = 86_400_000;
const THIS_MONTH_END = "2026-12-01T00:00:00Z";

/** Gives account A a key through the route, and the key it was given, through the other. */
async function issueAndReveal(portal: Portal, id = ACCOUNT_A): Promise<string> {
  expect((await portal.hub("issue", { id })).body).toEqual({ outcome: "issued" });
  return (await portal.hub("reveal", { id })).body.value as string;
}

describe("the gate on every route", () => {
  it("answers 401 without a bearer, with a malformed one and with Prices' token, and reads nothing", async () => {
    const portal = await startPortal();
    for (const act of ACTS) {
      const { method, path } = ROUTES[act];
      for (const token of [undefined, "garbage", "v1..", PRICES_TOKEN]) {
        const answer = await portal.call(method, path, token === undefined ? {} : { token });
        expect(answer.status).toBe(401);
        expect(answer.body).toEqual({
          code: "invalid_token",
          message: expect.any(String) as string,
        });
      }
      const odd = await portal.call(method, path, { headers: { authorization: "Basic abc" } });
      expect(odd.status).toBe(401);
    }
    expect(portal.keys.calls).toBe(0);
  });

  it("answers 403 to a good token for another route's act, and reads nothing", async () => {
    const portal = await startPortal();
    for (const route of ACTS) {
      for (const act of ACTS.filter((other) => other !== route)) {
        const { method, path } = ROUTES[route];
        const answer = await portal.call(method, path, { token: portal.token(act) });
        expect(answer.status).toBe(403);
        expect(answer.body).toEqual({
          code: "action_not_allowed",
          message: expect.any(String) as string,
        });
      }
    }
    expect(portal.keys.calls).toBe(0);
  });

  it("answers 404 not_found to another method or path, without looking at the token", async () => {
    const portal = await startPortal();
    for (const act of ACTS) {
      const { method, path } = ROUTES[act];
      const other = method === "GET" ? "POST" : "GET";
      for (const token of [portal.token(act), undefined]) {
        const answer = await portal.call(other, path, token === undefined ? {} : { token });
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ code: "not_found", message: expect.any(String) as string });
      }
    }
    for (const path of ["/", "/api", "/api/hub/v1", "/api/hub/v1/key", "/api/hub/v2/account"]) {
      const answer = await portal.call("GET", path, { token: "garbage" });
      expect(answer.status).toBe(404);
      expect(answer.body.code).toBe("not_found");
    }
    expect(portal.keys.calls).toBe(0);
  });

  it("sends no CORS header, even to a page that names its origin, and never caches", async () => {
    const portal = await startPortal();
    const origin = { origin: "https://sorobanscan.com" };
    const answers = [
      await portal.hub("read", { headers: origin }),
      await portal.call("GET", ROUTES.read.path, { headers: origin }),
      await portal.hub("revoke", { headers: origin }),
      await portal.call("GET", "/api/nothing", { headers: origin }),
      await portal.call("OPTIONS", ROUTES.read.path, { headers: origin }),
    ];
    for (const answer of answers) {
      for (const name of answer.headers.keys()) expect(name).not.toMatch(/^access-control-/);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("answers 404 not_found to HEAD, before the token and without counting", async () => {
    const portal = await startPortal();
    const bare = await portal.call("HEAD", ROUTES.read.path);
    const withToken = await portal.call("HEAD", ROUTES.read.path, { token: portal.token("read") });
    expect([bare.status, withToken.status]).toEqual([404, 404]);
    expect(portal.keys.calls).toBe(0);
    expect(portal.logs).toEqual([]);
  });

  it("answers /health outside the token and the limits", async () => {
    const portal = await startPortal();
    expect((await portal.call("GET", "/health")).body).toEqual({ ready: true });
    const down = await startPortal({ ready: () => Promise.reject(new Error("no db")) });
    const answer = await down.call("GET", "/health");
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ ready: false });
  });

  it("answers 500 internal to an unhandled error, with nothing of it", async () => {
    const quiet = () => undefined;
    // A logger that throws on the account's own info line fails the handler outside its store's try.
    const portal = await startPortal({
      logger: {
        debug: quiet,
        warn: quiet,
        error: quiet,
        info: () => {
          throw new Error("sync throw");
        },
      },
    });
    const answer = await portal.hub("read");
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ code: "internal", message: expect.any(String) as string });
    expect(JSON.stringify(answer.body)).not.toContain("sync throw");
  });
});

describe("GET /health", () => {
  /** `count` calls at once. */
  const many = (portal: Portal, count: number) =>
    Promise.all(Array.from({ length: count }, () => portal.call("GET", "/health")));

  it("asks the database once a window: calls during the probe and after it share its answer", async () => {
    let probes = 0;
    // Settles a moment later, so that most of the calls arrive while it is under way.
    const ready = () => {
      probes += 1;
      return new Promise<void>((resolve) => setTimeout(resolve, 20));
    };
    const portal = await startPortal({ ready });
    const answers = await many(portal, 50);
    expect(answers.map((answer) => [answer.status, answer.body])).toEqual(
      Array.from({ length: 50 }, () => [200, { ready: true }]),
    );
    expect(probes).toBe(1);
    portal.advance(HEALTH_WINDOW_MS - 1);
    expect((await portal.call("GET", "/health")).status).toBe(200);
    expect(probes).toBe(1);
    portal.advance(1);
    expect((await portal.call("GET", "/health")).status).toBe(200);
    expect(probes).toBe(2);
  });

  it("answers every call 503 while the database is down, logs not_ready once a window, and 200 once it is back", async () => {
    let probes = 0;
    let up = false;
    const ready = () => {
      probes += 1;
      return up ? Promise.resolve() : Promise.reject(new Error("no db"));
    };
    const portal = await startPortal({ ready });
    const notReady = () => portal.logs.filter((line) => line.event === "not_ready");

    const answers = await many(portal, 50);
    expect(answers.map((answer) => [answer.status, answer.body])).toEqual(
      Array.from({ length: 50 }, () => [503, { ready: false }]),
    );
    expect(probes).toBe(1);
    expect(notReady()).toHaveLength(1);
    expect(notReady()[0]!.level).toBe("error");

    // Still down in the next window: one more probe, one more line.
    portal.advance(HEALTH_WINDOW_MS);
    expect((await many(portal, 10)).map((answer) => answer.status)).toEqual(Array(10).fill(503));
    expect([probes, notReady().length]).toEqual([2, 2]);

    // Back, but the window's answer stands until it ends.
    up = true;
    expect((await portal.call("GET", "/health")).status).toBe(503);
    portal.advance(HEALTH_WINDOW_MS);
    const back = await portal.call("GET", "/health");
    expect([back.status, back.body]).toEqual([200, { ready: true }]);
    expect([probes, notReady().length]).toEqual([3, 2]);
  });

  it("logs one not_ready when probes of two windows hang and fail together", async () => {
    const fail: ((error: Error) => void)[] = [];
    const ready = () => new Promise<void>((_resolve, reject) => void fail.push(reject));
    const portal = await startPortal({ ready });
    const first = portal.call("GET", "/health");
    await vi.waitFor(() => expect(fail).toHaveLength(1));
    portal.advance(HEALTH_WINDOW_MS);
    const second = portal.call("GET", "/health");
    await vi.waitFor(() => expect(fail).toHaveLength(2));
    for (const reject of fail) reject(new Error("no db"));
    expect([(await first).status, (await second).status]).toEqual([503, 503]);
    expect(portal.logs.filter((line) => line.event === "not_ready")).toHaveLength(1);
  });
});

describe("GET /api/hub/v1/account", () => {
  it("is none for an account the store has never seen", async () => {
    const portal = await startPortal();
    const answer = await portal.hub("read");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      key: { state: "none", can_issue: true },
      details: { showable: false },
    });
  });

  it("is active, with the key's id and when it was made, and showable for a sealed key", async () => {
    const portal = await startPortal();
    const value = await issueAndReveal(portal);
    const answer = await portal.hub("read");
    expect(answer.body).toEqual({
      key: {
        state: "active",
        key_id: apiKeyHash(value).slice(0, 12),
        created_at: "2026-11-18T12:00:00Z",
        can_issue: false,
      },
      details: { showable: true },
    });
  });

  it("logs an unreadable copy as an error, and a key with no copy not at all", async () => {
    const portal = await startPortal();
    await portal.keys.issue({
      hash: apiKeyHash("x402_" + "b".repeat(43)),
      owner: OWNER_A,
      now: NOW,
    });
    await portal.hub("read");
    expect(portal.logs.some((l) => l.event === "hub_key_copy_unreadable")).toBe(false);

    const other = "x402_" + "c".repeat(43);
    const owner = ownerOf(ACCOUNT_B);
    const foreign = sealer(Buffer.alloc(32, 1)).seal(other, owner, apiKeyHash(other));
    await portal.keys.issue({ hash: apiKeyHash(other), owner, sealed: foreign, now: NOW });
    await portal.hub("read", { id: ACCOUNT_B });
    const unreadable = portal.logs.filter((l) => l.event === "hub_key_copy_unreadable");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({
      level: "error",
      fields: { jti: "jti-read", act: "read", key_id: apiKeyHash(other).slice(0, 12) },
    });
  });

  it("is revoked this month, with the day a new key can be made, and can't issue", async () => {
    const portal = await startPortal();
    await issueAndReveal(portal);
    portal.advance(DAY);
    await portal.hub("revoke");
    const answer = await portal.hub("read");
    expect(answer.body).toEqual({
      key: {
        state: "revoked",
        revoked_at: "2026-11-19T12:00:00Z",
        next_eligible_at: THIS_MONTH_END,
        can_issue: false,
      },
      details: { showable: false },
    });
  });

  it("is revoked in an earlier month: can issue, and names no day", async () => {
    const portal = await startPortal();
    const hash = apiKeyHash("x402_" + "a".repeat(43));
    await portal.keys.issue({ hash, owner: OWNER_A, now: Date.UTC(2026, 9, 5) });
    await portal.keys.revoke(OWNER_A, Date.UTC(2026, 9, 20, 8));
    const answer = await portal.hub("read");
    expect(answer.body).toEqual({
      key: { state: "revoked", revoked_at: "2026-10-20T08:00:00Z", can_issue: true },
      details: { showable: false },
    });
  });

  it("is active but not showable for a key with no copy and for one sealed under another key", async () => {
    const portal = await startPortal();
    const bare = "x402_" + "b".repeat(43);
    await portal.keys.issue({ hash: apiKeyHash(bare), owner: OWNER_A, now: NOW });
    const noCopy = await portal.hub("read");
    expect(noCopy.body.key.state).toBe("active");
    expect(noCopy.body.details).toEqual({ showable: false });

    const other = "x402_" + "c".repeat(43);
    const foreign = sealer(Buffer.alloc(32, 1)).seal(other, ownerOf(ACCOUNT_B), apiKeyHash(other));
    await portal.keys.issue({
      hash: apiKeyHash(other),
      owner: ownerOf(ACCOUNT_B),
      sealed: foreign,
      now: NOW,
    });
    const wrongKey = await portal.hub("read", { id: ACCOUNT_B });
    expect(wrongKey.body.key.state).toBe("active");
    expect(wrongKey.body.details).toEqual({ showable: false });
  });
});

describe("POST /api/hub/v1/key/reveal", () => {
  it("returns the very key that was issued", async () => {
    const portal = await startPortal();
    const value = await issueAndReveal(portal);
    expect(isApiKey(value)).toBe(true);
    expect(await portal.keys.ownerOf(apiKeyHash(value))).toBe(OWNER_A);
    const again = await portal.hub("reveal");
    expect(again.body).toEqual({
      key_id: apiKeyHash(value).slice(0, 12),
      value,
      created_at: "2026-11-18T12:00:00Z",
    });
  });

  it("is 404 no_key for an account never seen", async () => {
    const portal = await startPortal();
    const answer = await portal.hub("reveal");
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ code: "no_key", message: expect.any(String) as string });
  });

  it("is 404 key_revoked, with both instants, while the month's cap holds", async () => {
    const portal = await startPortal();
    await issueAndReveal(portal);
    await portal.hub("revoke");
    const answer = await portal.hub("reveal");
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({
      code: "key_revoked",
      message: expect.any(String) as string,
      details: { next_eligible_at: THIS_MONTH_END, revoked_at: "2026-11-18T12:00:00Z" },
    });
  });

  it("is 404 no_key when the key was revoked last month", async () => {
    const portal = await startPortal();
    const hash = apiKeyHash("x402_" + "a".repeat(43));
    await portal.keys.issue({ hash, owner: OWNER_A, now: Date.UTC(2026, 9, 5) });
    await portal.keys.revoke(OWNER_A, Date.UTC(2026, 9, 20));
    const answer = await portal.hub("reveal");
    expect(answer.status).toBe(404);
    expect(answer.body.code).toBe("no_key");
  });

  it("is 409 key_not_viewable for a key with no copy and one that doesn't open; only the latter is logged as unreadable", async () => {
    const portal = await startPortal();
    const bare = "x402_" + "b".repeat(43);
    await portal.keys.issue({ hash: apiKeyHash(bare), owner: OWNER_A, now: NOW });
    const noCopy = await portal.hub("reveal");
    expect(noCopy.status).toBe(409);
    expect(noCopy.body).toEqual({
      code: "key_not_viewable",
      message: expect.any(String) as string,
    });
    expect(portal.logs.some((l) => l.event === "hub_key_copy_unreadable")).toBe(false);

    const other = "x402_" + "c".repeat(43);
    const owner = ownerOf(ACCOUNT_B);
    const foreign = sealer(Buffer.alloc(32, 1)).seal(other, owner, apiKeyHash(other));
    await portal.keys.issue({ hash: apiKeyHash(other), owner, sealed: foreign, now: NOW });
    const wrong = await portal.hub("reveal", { id: ACCOUNT_B });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("key_not_viewable");
    const unreadable = portal.logs.filter((l) => l.event === "hub_key_copy_unreadable");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.level).toBe("error");
  });

  it("treats a copy whose opening throws as one that does not open", async () => {
    const real = sealer(ENCRYPTION_KEY);
    const portal = await startPortal({
      sealer: {
        seal: real.seal,
        open: () => {
          throw new Error("bad decipher");
        },
      },
    });
    await portal.hub("issue");
    const answer = await portal.hub("reveal");
    expect(answer.status).toBe(409);
    expect((await portal.hub("read")).body.details).toEqual({ showable: false });
  });
});

describe("POST /api/hub/v1/key/revoke", () => {
  it("ends the key and deletes its copy, answering when and until when", async () => {
    const portal = await startPortal();
    const value = await issueAndReveal(portal);
    expect(portal.keys.copyCount()).toBe(1);
    const answer = await portal.hub("revoke");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      revoked: true,
      revoked_at: "2026-11-18T12:00:00Z",
      next_eligible_at: THIS_MONTH_END,
    });
    expect(await portal.keys.ownerOf(apiKeyHash(value))).toBeUndefined();
    expect(portal.keys.copyCount()).toBe(0);
  });

  it("is 404 no_key the second time", async () => {
    const portal = await startPortal();
    await portal.hub("issue");
    await portal.hub("revoke");
    const answer = await portal.hub("revoke");
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ code: "no_key", message: expect.any(String) as string });
    expect((await portal.hub("revoke", { id: ACCOUNT_B })).status).toBe(404);
  });

  it("works for a key that can't be shown", async () => {
    const portal = await startPortal();
    const bare = "x402_" + "b".repeat(43);
    await portal.keys.issue({ hash: apiKeyHash(bare), owner: OWNER_A, now: NOW });
    expect((await portal.hub("revoke")).body.revoked).toBe(true);
    expect(await portal.keys.ownerOf(apiKeyHash(bare))).toBeUndefined();
  });
});

describe("POST /api/hub/v1/key/issue", () => {
  it("issues a key whose copy opens to one the registry accepts", async () => {
    const portal = await startPortal();
    const answer = await portal.hub("issue");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ outcome: "issued" });
    const held = await portal.keys.keysOf(OWNER_A);
    expect(held.active?.sealed).toBeDefined();
    const value = sealer(ENCRYPTION_KEY).open(held.active!.sealed!, OWNER_A, held.active!.hash);
    expect(isApiKey(value ?? "")).toBe(true);
    expect(apiKeyHash(value!)).toBe(held.active!.hash);
  });

  it("answers has_key the second time and stores nothing new", async () => {
    const portal = await startPortal();
    await portal.hub("issue");
    const before = (await portal.keys.list()).length;
    const answer = await portal.hub("issue");
    expect(answer.body).toEqual({ outcome: "has_key" });
    expect((await portal.keys.list()).length).toBe(before);
  });

  it("answers capped, with the day, for a key revoked this month, and issues one revoked last month", async () => {
    const portal = await startPortal();
    await portal.hub("issue");
    await portal.hub("revoke");
    expect((await portal.hub("issue")).body).toEqual({
      outcome: "capped",
      next_eligible_at: THIS_MONTH_END,
    });
    expect((await portal.keys.keysOf(OWNER_A)).active).toBeUndefined();

    const hash = apiKeyHash("x402_" + "a".repeat(43));
    const owner = ownerOf(ACCOUNT_B);
    await portal.keys.issue({ hash, owner, now: Date.UTC(2026, 9, 5) });
    await portal.keys.revoke(owner, Date.UTC(2026, 9, 20));
    expect((await portal.hub("issue", { id: ACCOUNT_B })).body).toEqual({ outcome: "issued" });
  });

  it("answers too_young for an account a minute old, with when it will do, and reads nothing", async () => {
    const portal = await startPortal();
    const answer = await portal.hub("issue", { id: YOUNG_ACCOUNT });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ outcome: "too_young", next_eligible_at: "2026-11-18T12:04:00Z" });
    expect(portal.keys.calls).toBe(0);
  });

  it("refuses a token naming an id that isn't a snowflake at the gate, before the handler", async () => {
    const portal = await startPortal();
    const answer = await portal.hub("issue", { id: "abc" });
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("invalid_token");
    expect(portal.keys.calls).toBe(0);
  });

  it("gives one of two issues that both read before either writes the key, and the other has_key", async () => {
    const portal = await startPortal();
    // Each call waits after reading until both have read, so the loser reaches `keys.issue`.
    let reads = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const read = portal.keys.keysOf.bind(portal.keys);
    portal.keys.keysOf = async (owner) => {
      const held = await read(owner);
      if (++reads === 2) release();
      await both;
      return held;
    };
    const answers = await Promise.all([portal.hub("issue"), portal.hub("issue")]);
    expect(reads).toBe(2);
    expect(answers.map((a) => a.body.outcome).sort()).toEqual(["has_key", "issued"]);
    expect((await portal.keys.list()).filter((k) => k.state === "active")).toHaveLength(1);
    expect(portal.logs.filter((l) => l.event === "hub_key_issued")).toHaveLength(1);
  });

  it("answers failed, 200, when the store fails, with nothing of the error", async () => {
    const portal = await startPortal();
    portal.keys.failing = true;
    const answer = await portal.hub("issue");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ outcome: "failed" });
    expect(portal.logs.find((l) => l.event === "hub_call_failed")?.level).toBe("error");
  });
});

describe("a store that fails", () => {
  // 502, as Prices answers a store that failed: the hub tries a 503 once more, a 502 never.
  it("answers 502 key_unavailable on account, reveal and revoke, with nothing of the error", async () => {
    const portal = await startPortal();
    portal.keys.failing = true;
    for (const act of ["read", "reveal", "revoke"] as const) {
      const answer = await portal.hub(act);
      expect(answer.status).toBe(502);
      expect(answer.body).toEqual({
        code: "key_unavailable",
        message: expect.any(String) as string,
      });
      expect(JSON.stringify(answer.body)).not.toMatch(/secret|postgres|ECONNREFUSED/);
    }
  });
});

describe("the limits", () => {
  it("lets an account 60 calls a minute, then 429 with Retry-After, apart from another account on the same address", async () => {
    const portal = await startPortal();
    for (let i = 0; i < ACCOUNT_LIMIT_PER_MINUTE; i++) {
      expect((await portal.hub("read")).status).toBe(200);
    }
    const over = await portal.hub("read");
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ code: "rate_limited", message: expect.any(String) as string });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await portal.hub("read", { id: ACCOUNT_B })).status).toBe(200);

    portal.advance(60_000);
    expect((await portal.hub("read")).status).toBe(200);
  });

  it("lets an address 30 unverified tokens a minute, then 429, and still answers a good token from it", async () => {
    const portal = await startPortal();
    for (let i = 0; i < STRANGER_LIMIT_PER_MINUTE; i++) {
      expect((await portal.call("GET", ROUTES.read.path, { token: "garbage" })).status).toBe(401);
    }
    const over = await portal.call("GET", ROUTES.read.path, { token: "garbage" });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await portal.hub("read")).status).toBe(200);

    portal.advance(60_000);
    expect((await portal.call("GET", ROUTES.read.path, { token: "garbage" })).status).toBe(401);
  });

  it("logs a refused stranger once a window, and a 429 is not logged as a bad token", async () => {
    const portal = await startPortal();
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      statuses.push((await portal.call("GET", ROUTES.read.path, { token: "garbage" })).status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(portal.logs.filter((l) => l.event === "hub_call_refused")).toHaveLength(30);
    const limited = portal.logs.filter((l) => l.event === "hub_strangers_limited");
    expect(limited).toHaveLength(1);
    expect(limited[0]?.level).toBe("warn");
    expect(JSON.stringify(limited)).not.toContain("127.0.0.1");
  });

  it("counts a stranger by Cloudflare's header when told to, and by the socket otherwise", async () => {
    const behind = await startPortal({ config: { clientIp: "cloudflare" } });
    const from = (ip: string) =>
      behind.call("GET", ROUTES.read.path, {
        token: "garbage",
        headers: { "cf-connecting-ip": ip },
      });
    for (let i = 0; i < STRANGER_LIMIT_PER_MINUTE; i++) await from("203.0.113.1");
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(401);

    const direct = await startPortal();
    for (let i = 0; i < STRANGER_LIMIT_PER_MINUTE; i++) {
      await direct.call("GET", ROUTES.read.path, {
        token: "garbage",
        headers: { "cf-connecting-ip": `203.0.113.${i}` },
      });
    }
    const last = await direct.call("GET", ROUTES.read.path, {
      token: "garbage",
      headers: { "cf-connecting-ip": "203.0.113.200" },
    });
    expect(last.status).toBe(429);
  });

  // One /64 holds more addresses than any window, so an address of its own each would let one
  // client past the limit and log every call. The facilitator counts IPv6 the same way.
  it("counts an IPv6 stranger by its /56, so a client can't rotate addresses past the limit", async () => {
    const portal = await startPortal({ config: { clientIp: "cloudflare" } });
    const from = (ip: string) =>
      portal.call("GET", ROUTES.read.path, {
        token: "garbage",
        headers: { "cf-connecting-ip": ip },
      });
    // Each from an address of its own, all in 2001:db8::/56.
    for (let i = 0; i < STRANGER_LIMIT_PER_MINUTE; i++) {
      expect((await from(`2001:db8:0:${i.toString(16)}::${i + 1}`)).status).toBe(401);
    }
    expect((await from("2001:db8:0:ff:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await from("2001:db8:0:100::1")).status).toBe(401);
    expect(portal.logs.filter((l) => l.event === "hub_call_refused")).toHaveLength(
      STRANGER_LIMIT_PER_MINUTE + 1,
    );
  });
});

describe("the logs", () => {
  it("never hold the token, a key, the secret, the Discord id or the username; key events hold jti, act and key_id", async () => {
    const portal = await startPortal();
    const tokens: string[] = [];
    const run = async (act: Act, id?: string) => {
      const token = portal.token(act, id === undefined ? {} : { id });
      tokens.push(token);
      return portal.hub(act, { token });
    };
    const value = (
      await (async () => {
        await run("issue");
        return run("reveal");
      })()
    ).body.value as string;
    await run("read");
    await run("issue");
    await run("revoke");
    await run("reveal");
    await run("issue");
    await run("revoke");
    await run("issue", YOUNG_ACCOUNT);
    await portal.call("GET", ROUTES.read.path, { token: "garbage" });
    await portal.call("GET", ROUTES.read.path);
    await portal.call("GET", ROUTES.read.path, { token: portal.token("issue") });
    portal.keys.failing = true;
    await run("read");
    await run("issue", ACCOUNT_B);

    const text = JSON.stringify(portal.logs);
    for (const secret of [
      ...tokens,
      ...tokens.map((t) => t.split(".")[1]!),
      value,
      SECRET.toString("base64"),
      SECRET.toString("base64url"),
      SECRET.toString("hex"),
      ACCOUNT_A,
      ACCOUNT_B,
      YOUNG_ACCOUNT,
      USERNAME,
    ]) {
      expect(text).not.toContain(secret);
    }
    const events = new Set(portal.logs.map((l) => l.event));
    for (const event of [
      "hub_account_answered",
      "hub_key_issued",
      "hub_key_revoked",
      "hub_key_revealed",
      "hub_issue_refused",
      "hub_reveal_refused",
      "hub_revoke_refused",
      "hub_call_refused",
      "hub_call_failed",
    ]) {
      expect(events.has(event), event).toBe(true);
    }
    for (const line of portal.logs.filter((l) =>
      ["hub_key_issued", "hub_key_revoked", "hub_key_revealed"].includes(l.event),
    )) {
      expect(line.fields).toMatchObject({
        jti: expect.any(String) as string,
        act: expect.any(String) as string,
        key_id: apiKeyHash(value).slice(0, 12),
      });
    }
  });
});
