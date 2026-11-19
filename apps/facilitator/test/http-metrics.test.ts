import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { byName } from "@stellar-x402/metrics-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { routeLabel } from "../src/http/app.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/start.js";
import { memoryMetrics, type Labels } from "../src/metrics.js";
import type { Stores } from "../src/ports/index.js";
import type { LeaseKeeper } from "../src/settlement/lease.js";
import type { Verify } from "../src/settlement/verify.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "1000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  extra: {},
};
const request = {
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
  paymentRequirements: requirements,
};

const db = testDatabase();
beforeEach(db.empty);

let app: Started | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A lease this process never holds: `/settle` answers 503 `no_lease`. */
const noLease: LeaseKeeper = {
  held: () => false,
  current: () => undefined,
  start: async () => {},
  runOnce: async () => {},
  close: async () => {},
  release: async () => {},
};

/**
 * A facilitator whose metrics remember every `http_requests_total` increment. A budget of 2 on
 * `/discovery`, in an hour's window so a test's requests share one.
 */
async function serve(deps: { verify?: Verify; lease?: LeaseKeeper; stores?: Stores } = {}) {
  const config = parseConfig({
    ...signerEnv(Keypair.random().publicKey()),
    DATABASE_URL: db.urlFor(db.schema),
    CLIENT_IP: "socket",
    CHANNELS: Keypair.random().publicKey(),
    PORT: "0",
    RATE_LIMIT_VERIFY: "10",
    RATE_LIMIT_SETTLE: "10",
    RATE_LIMIT_DISCOVERY: "2",
    RATE_LIMIT_WINDOW_MS: "3600000",
  });
  const metrics = memoryMetrics();
  const counted: Labels[] = [];
  const increment = metrics.increment;
  metrics.increment = (name, labels, by) => {
    if (name === "http_requests_total") counted.push({ ...labels });
    increment(name, labels, by);
  };
  app = await start({
    config,
    logger: jsonLogger("debug", () => {}),
    metrics,
    stores: deps.stores ?? db.stores(),
    verify: deps.verify ?? (async () => ({ isValid: true })),
    settle: async () => ({
      response: { success: false, transaction: "", network: config.network },
    }),
    extensionResponses: () => undefined,
    supported: supportedResponse(config.network, Keypair.random().publicKey()),
    lease: deps.lease,
  });
  const url = `http://127.0.0.1:${app.port}`;
  const post = (path: string, body: unknown = request, signal?: AbortSignal) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  /** The count for exactly `{ route, status }`, once the answer's `close` has fired. */
  const count = (route: string, status: string) =>
    metrics.value("http_requests_total", { route, status });
  return { url, post, count, counted };
}

describe("http_requests_total", () => {
  it("counts a 200 /verify as {route:'/verify',status:'200'}", async () => {
    const { post, count, counted } = await serve();
    expect((await post("/verify")).status).toBe(200);
    await vi.waitFor(() => expect(count("/verify", "200")).toBe(1));
    expect(counted).toEqual([{ route: "/verify", status: "200" }]);
  });

  it("counts a rate-limited /discovery/resources under route /discovery, status 429", async () => {
    const { url, count } = await serve();
    const get = () => fetch(`${url}/discovery/resources`);
    await get();
    await get();
    expect((await get()).status).toBe(429);
    await vi.waitFor(() => expect(count("/discovery", "429")).toBe(1));
  });

  it("counts a request refused for want of an API key as status 401, which the catalog lists (0105)", async () => {
    const { post, count, counted } = await serve();
    const pubnet = { ...requirements, network: "stellar:pubnet" };
    const refused = await post("/settle", {
      ...request,
      paymentPayload: { ...request.paymentPayload, accepted: pubnet },
      paymentRequirements: pubnet,
    });
    expect(refused.status).toBe(401);
    await vi.waitFor(() => expect(count("/settle", "401")).toBe(1));
    expect(counted).toEqual([{ route: "/settle", status: "401" }]);
    // Outside the list, the EMF line would write it as `other` and report an unknown value.
    expect(byName("http_requests_total")?.values?.status).toContain("401");
  });

  it("counts an unknown path under route other, status 404", async () => {
    const { url, count, counted } = await serve();
    expect((await fetch(`${url}/admin/../etc?x=1`)).status).toBe(404);
    expect((await fetch(`${url}/verify/extra`)).status).toBe(404);
    expect((await fetch(`${url}/discoveryx`)).status).toBe(404);
    await vi.waitFor(() => expect(count("other", "404")).toBe(3));
    // Never a raw path: each label is from the fixed map.
    expect(counted.every((labels) => labels.route === "other")).toBe(true);
  });

  it("names a route as Express routes it: any case, a trailing slash", async () => {
    const { url, count } = await serve();
    expect((await fetch(`${url}/SUPPORTED/`)).status).toBe(200);
    expect((await fetch(`${url}/Health`)).status).toBe(200);
    await vi.waitFor(() => expect(count("/supported", "200")).toBe(1));
    await vi.waitFor(() => expect(count("/health", "200")).toBe(1));
  });

  it("maps each path to a fixed route", () => {
    const cases: [string, string][] = [
      ["/verify", "/verify"],
      ["/settle/", "/settle"],
      ["/discovery", "/discovery"],
      ["/discovery/resources", "/discovery"],
      ["/discovery/a/b", "/discovery"],
      ["/discoveryx", "other"],
      ["/verify/extra", "other"],
      ["/", "other"],
      ["//", "other"],
      ["/wp-admin", "other"],
    ];
    expect(cases.map(([path]) => [path, routeLabel(path)])).toEqual(cases);
  });

  it("counts a handler that throws as status 500", async () => {
    const { post, count } = await serve({
      verify: async () => {
        throw new Error("boom");
      },
    });
    expect((await post("/verify")).status).toBe(500);
    await vi.waitFor(() => expect(count("/verify", "500")).toBe(1));
  });

  it("counts a /settle without the lease as 503, not 500", async () => {
    const { post, count, counted } = await serve({ lease: noLease });
    expect((await post("/settle")).status).toBe(503);
    await vi.waitFor(() => expect(count("/settle", "503")).toBe(1));
    expect(counted).toEqual([{ route: "/settle", status: "503" }]);
  });

  it("counts a client that left before the answer as aborted", async () => {
    let answer!: (response: VerifyResponse) => void;
    const verify = vi.fn<Verify>(() => new Promise((resolve) => (answer = resolve)));
    const { post, count, counted } = await serve({ verify });
    const client = new AbortController();
    const sent = post("/verify", request, client.signal).catch(() => undefined);
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    client.abort();
    await sent;
    await vi.waitFor(() => expect(count("/verify", "aborted")).toBe(1));
    // The handler answers after the client left: still the one count.
    answer({ isValid: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counted).toEqual([{ route: "/verify", status: "aborted" }]);
  });

  it("names the route of a client that left inside /discovery's rate limit", async () => {
    // Express strips `/discovery` from `req.url` while the limit runs.
    const stores = db.stores();
    const hit = vi.fn<Stores["rateLimits"]["hit"]>(() => new Promise(() => {}));
    const { url, count } = await serve({
      stores: { ...stores, rateLimits: { ...stores.rateLimits, hit } },
    });
    const client = new AbortController();
    const sent = fetch(`${url}/discovery/resources`, { signal: client.signal }).catch(
      () => undefined,
    );
    await vi.waitFor(() => expect(hit).toHaveBeenCalled());
    client.abort();
    await sent;
    await vi.waitFor(() => expect(count("/discovery", "aborted")).toBe(1));
  });

  it("counts each request exactly once", async () => {
    const { url, post, counted } = await serve();
    const answers = await Promise.all([
      post("/verify"),
      post("/verify", {}),
      post("/settle"),
      fetch(`${url}/supported`),
      fetch(`${url}/health`),
      fetch(`${url}/discovery/resources`),
      fetch(`${url}/nope`),
      fetch(`${url}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    ]);
    expect(answers.map((r) => r.status)).toEqual([200, 400, 200, 200, 200, 200, 404, 400]);
    await vi.waitFor(() => expect(counted).toHaveLength(answers.length));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counted).toHaveLength(answers.length);
    expect(counted.map((labels) => `${labels.route} ${labels.status}`).sort()).toEqual(
      [
        "/verify 200",
        "/verify 400",
        "/verify 400",
        "/settle 200",
        "/supported 200",
        "/health 200",
        "/discovery 200",
        "other 404",
      ].sort(),
    );
  });
});
