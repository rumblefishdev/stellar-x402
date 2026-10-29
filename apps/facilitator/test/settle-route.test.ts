import { once } from "node:events";
import net from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCataloger } from "../src/catalog/cataloger.js";
import { parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { MAX_BODY_DEPTH, NO_LEASE_RETRY_AFTER_S } from "../src/http/app.js";
import { start, type Started } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementRecord } from "../src/ports/index.js";
import type { SettlementHooks } from "../src/settlement/hooks.js";
import type { Reconciliation } from "../src/settlement/reconcile.js";
import type { Settle } from "../src/settlement/settle.js";
import { testDatabase } from "./database.js";
import { bazaarExtensions, depthOf } from "./payment.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "1000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  extra: {},
};
// `accepted` differs from the requirements, so the test sees which one reaches the settler.
const paymentPayload = {
  x402Version: 2,
  accepted: { ...requirements, amount: "1" },
  payload: { transaction: "AAAA" },
};
const request = { x402Version: 2, paymentPayload, paymentRequirements: requirements };
const success = {
  success: true,
  transaction: "a".repeat(64),
  network: "stellar:testnet",
  payer: "GPAYER",
} as const;
const record = { key: "stellar:testnet:GPAYER:7" } as unknown as SettlementRecord;

describe("POST /settle", () => {
  const db = testDatabase();
  const lines: string[] = [];
  const settle = vi.fn<Settle>();
  const extensionResponses = vi.fn<SettlementHooks["extensionResponses"]>();
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      DATABASE_URL: db.urlFor(db.schema),
      CLIENT_IP: "socket",
      CHANNELS: Keypair.random().publicKey(),
    };
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    app = await start({
      config,
      logger,
      metrics: memoryMetrics(),
      stores: db.stores(),
      verify: async () => ({ isValid: true }),
      settle,
      extensionResponses,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
    });
    url = `http://127.0.0.1:${app.port}/settle`;
  });
  afterAll(() => app.close());
  beforeEach(() => {
    settle.mockReset();
    extensionResponses.mockReset();
    lines.length = 0;
  });

  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers 200 with a success body and the EXTENSION-RESPONSES header, then runs afterResponse", async () => {
    const afterResponse = vi.fn();
    settle.mockResolvedValueOnce({ response: success, record, afterResponse, key: record.key });
    extensionResponses.mockReturnValueOnce({ bazaar: { status: "processing" } });

    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, success]);
    expect(settle).toHaveBeenCalledWith(paymentPayload, requirements, expect.any(AbortSignal));
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "settled", settlementKey: record.key, replay: false }),
    );
    expect(extensionResponses).toHaveBeenCalledWith(record);
    const header = response.headers.get("extension-responses");
    expect(JSON.parse(Buffer.from(header!, "base64").toString())).toEqual({
      bazaar: { status: "processing" },
    });
    await vi.waitFor(() => expect(afterResponse).toHaveBeenCalledTimes(1));
  });

  it("tells the settler when the client leaves before the answer, and still runs afterResponse", async () => {
    let aborted!: (value: boolean) => void;
    const seen = new Promise<boolean>((resolve) => (aborted = resolve));
    // A settlement that landed while its client left: cataloging must not stop (0031).
    const afterResponse = vi.fn();
    settle.mockImplementationOnce(
      (_payload, _requirements, signal) =>
        new Promise((resolve) => {
          signal!.addEventListener("abort", () => {
            aborted(true);
            // After the close event, so the route finds the response closed.
            setTimeout(() => resolve({ response: success, afterResponse }), 10);
          });
        }),
    );
    const client = new AbortController();
    const request_ = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: client.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(settle).toHaveBeenCalled());
    client.abort();
    await request_;
    expect(await seen).toBe(true);
    await vi.waitFor(() => expect(afterResponse).toHaveBeenCalledTimes(1));
  });

  it("sends no CORS headers", async () => {
    settle.mockResolvedValueOnce({ response: success });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://other.example" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  /** `request` with `extensions.deep`: `levels` arrays, the innermost at body depth `levels + 2`. */
  const nested = (levels: number) => {
    let deep: unknown = 0;
    for (let i = 0; i < levels; i++) deep = [deep];
    return { ...request, paymentPayload: { ...paymentPayload, extensions: { deep } } };
  };

  it("settles the payload upstream's client builds for a Bazaar resource with a deep output schema", async () => {
    settle.mockResolvedValue({ response: success, record });
    const body = {
      ...request,
      paymentPayload: { ...paymentPayload, extensions: bazaarExtensions(6) },
    };
    // Deeper than the old cap of 32 (0009 decision 39).
    expect(depthOf(body)).toBeGreaterThan(32);
    expect((await post(body)).status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("settles a body nested to MAX_BODY_DEPTH, and refuses one level deeper", async () => {
    settle.mockResolvedValue({ response: success, record });
    expect((await post(nested(MAX_BODY_DEPTH - 3))).status).toBe(200);
    expect((await post(nested(MAX_BODY_DEPTH - 2))).status).toBe(400);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for a body nested deeper than MAX_BODY_DEPTH, without settling", async () => {
    let deep: unknown = 0;
    for (let i = 0; i < MAX_BODY_DEPTH; i++) deep = [deep];
    const response = await post({
      ...request,
      paymentPayload: { ...paymentPayload, extensions: { deep } },
    });
    expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
    expect(settle).not.toHaveBeenCalled();
  });

  it("logs a fee refusal's message, which names archived entries, and no other failure's", async () => {
    const refusal = (errorReason: string, errorMessage: string) =>
      ({
        success: false,
        errorReason,
        errorMessage,
        transaction: "",
        network: "stellar:testnet",
      }) as const;
    const errorMessage =
      "simulation-derived fee 551787 stroops exceeds ceiling 250000 stroops; the payment's transaction lists 1 archived entry to restore: AAAABg==";
    settle.mockResolvedValueOnce({
      response: refusal("invalid_exact_stellar_payload_fee_exceeds_maximum", errorMessage),
    });
    settle.mockResolvedValueOnce({
      response: refusal("invalid_exact_stellar_payload_simulation_failed", "simulation failed"),
    });
    await post(request);
    await post(request);
    const settled = lines.map((line) => JSON.parse(line)).filter((l) => l.event === "settled");
    expect(settled.map((l) => l.message)).toEqual([errorMessage, undefined]);
  });

  it("sends no header when there are no extension responses or the answer is a failure", async () => {
    settle.mockResolvedValueOnce({ response: success, record });
    extensionResponses.mockReturnValueOnce(undefined);
    expect((await post(request)).headers.get("extension-responses")).toBeNull();

    const failure = {
      success: false,
      errorReason: "settlement_pending",
      transaction: "a".repeat(64),
      network: "stellar:testnet",
    } as const;
    settle.mockResolvedValueOnce({ response: failure });
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, failure]);
    expect(response.headers.get("extension-responses")).toBeNull();
    expect(extensionResponses).toHaveBeenCalledTimes(1);
  });

  it("keeps the success answer when the header can't be computed", async () => {
    settle.mockResolvedValueOnce({ response: success, record });
    extensionResponses.mockImplementationOnce(() => {
      throw new Error("bazaar bug");
    });
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, success]);
    expect(lines.join("")).toContain("extension_responses_failed");
  });

  it("settles a pubnet payment for a localhost resource, and only the listing is refused (0054)", async () => {
    const cataloger = createCataloger({
      store: db.stores().catalog,
      metrics: memoryMetrics(),
      logger: jsonLogger("debug", () => undefined),
    });
    const pubnet = {
      key: "stellar:pubnet:GPAYER:7",
      network: "stellar:pubnet",
      state: "success",
      ledger: 100,
      paymentPayload: {
        x402Version: 2,
        resource: { url: "http://localhost:4022/exact/stellar" },
        extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
      },
      paymentRequirements: { ...requirements, network: "stellar:pubnet" },
      updatedAt: 0,
    } as unknown as SettlementRecord;
    settle.mockResolvedValueOnce({ response: success, record: pubnet });
    extensionResponses.mockImplementationOnce(cataloger.extensionResponses);
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([200, success]);
    const header = response.headers.get("extension-responses");
    expect(JSON.parse(Buffer.from(header!, "base64").toString())).toEqual({
      bazaar: { status: "rejected", rejectedReason: "resource_not_public" },
    });
  });

  it("answers 400 for a NUL or a lone surrogate in any string or key, without settling", async () => {
    // PostgreSQL refuses a NUL in text and jsonb, and jsonb a lone surrogate: a 500 before money
    // moves, instead of the client's 400.
    for (const text of ["a\u0000b", "a\ud800b"]) {
      const bodies = [
        { ...request, paymentRequirements: { ...requirements, payTo: text } },
        { ...request, paymentPayload: { ...paymentPayload, extensions: { note: text } } },
        { ...request, paymentPayload: { ...paymentPayload, extensions: { [text]: 1 } } },
      ];
      for (const body of bodies) {
        const response = await post(body);
        expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
      }
    }
    expect(settle).not.toHaveBeenCalled();
    // A pair of surrogates is one character, and well formed.
    settle.mockResolvedValueOnce({ response: success, record });
    const emoji = { ...paymentPayload, extensions: { note: "\ud83d\ude00" } };
    expect((await post({ ...request, paymentPayload: emoji })).status).toBe(200);
  });

  it("answers 400 for a bad body, without settling", async () => {
    const response = await post({ ...request, x402Version: 1 });
    expect([response.status, await response.json()]).toEqual([400, { error: "bad_request" }]);
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers 500 and logs the error when settling throws", async () => {
    settle.mockRejectedValueOnce(new Error("store down"));
    const response = await post(request);
    expect([response.status, await response.json()]).toEqual([500, { error: "internal_error" }]);
    expect(lines.join("")).toContain("http_error");
  });
});

describe("POST /settle beside reconciliation (0019 decision 27)", () => {
  const db = testDatabase();
  it("serves while the first sweep runs, and starts and stops it with the server", async () => {
    const settle = vi.fn<Settle>(async () => ({ response: success }));
    const reconciliation = {
      reconciled: new Promise<void>(() => {}),
      listed: () => false,
      start: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      DATABASE_URL: db.urlFor(db.schema),
      CHANNELS: Keypair.random().publicKey(),
      CLIENT_IP: "socket",
    };
    const config = { ...parseConfig(env), port: 0 };
    const app = await start({
      config,
      logger: jsonLogger("error"),
      stores: db.stores(),
      verify: async () => ({ isValid: true }),
      settle,
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
      metrics: memoryMetrics(),
      reconciliation,
    });
    try {
      expect(reconciliation.start).toHaveBeenCalledTimes(1);
      const response = await fetch(`http://127.0.0.1:${app.port}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(settle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
    expect(reconciliation.close).toHaveBeenCalledTimes(1);
  });
});

describe("POST /settle without the channel lease (0025)", () => {
  const db = testDatabase();
  it("answers 503 at once, settles again once the lease is held, and starts and stops it", async () => {
    const settle = vi.fn<Settle>(async () => ({ response: success }));
    let holds = false;
    const lease = {
      held: () => holds,
      start: vi.fn(async () => {}),
      runOnce: vi.fn(),
      close: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const rateLimits = db.stores().rateLimits;
    const hit = vi.spyOn(rateLimits, "hit");
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      DATABASE_URL: db.urlFor(db.schema),
      CHANNELS: Keypair.random().publicKey(),
      CLIENT_IP: "socket",
    };
    const config = { ...parseConfig(env), port: 0 };
    const app = await start({
      config,
      logger: jsonLogger("error"),
      stores: { ...db.stores(), rateLimits },
      verify: async () => ({ isValid: true }),
      settle,
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
      metrics: memoryMetrics(),
      lease,
    });
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${app.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    try {
      expect(lease.start).toHaveBeenCalledTimes(1);
      const refused = await post("/settle");
      expect([refused.status, refused.headers.get("retry-after"), await refused.json()]).toEqual([
        503,
        `${NO_LEASE_RETRY_AFTER_S}`,
        { error: "no_lease" },
      ]);
      // No settle, and no store call for the rate limit either.
      expect(settle).not.toHaveBeenCalled();
      expect(hit).not.toHaveBeenCalled();
      // `/verify` doesn't need the lease.
      expect((await post("/verify")).status).toBe(200);
      holds = true;
      expect((await post("/settle")).status).toBe(200);
      expect(settle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
    // Nothing to drain here, so the server gives the lease up.
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * A client that sent part of a request's headers and stalls: `closed` turns true once the server
 * cuts its connection. Node stops timing out such a request once `server.close()` is called.
 */
async function stalled(url: string): Promise<{ readonly closed: boolean }> {
  const { port } = new URL(url);
  const socket = net.connect(Number(port), "127.0.0.1");
  await once(socket, "connect");
  socket.write("POST /settle HTTP/1.1\r\nHost: x\r\n");
  const state = { closed: false };
  socket.on("error", () => {});
  socket.on("close", () => (state.closed = true));
  return state;
}

describe("shutdown (0025)", () => {
  const db = testDatabase();
  async function started(opts: {
    drain?: () => Promise<void>;
    reconciliation?: Reconciliation;
    shutdownDeadlineMs?: number;
    shutdownGraceMs?: number;
  }) {
    const settle = vi.fn<Settle>(async () => ({ response: success }));
    const lease = {
      held: () => true,
      start: vi.fn(async () => {}),
      runOnce: vi.fn(),
      close: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const env = {
      FACILITATOR_SECRET: Keypair.random().secret(),
      DATABASE_URL: db.urlFor(db.schema),
      CHANNELS: Keypair.random().publicKey(),
      CLIENT_IP: "socket",
    };
    const config = { ...parseConfig(env), port: 0 };
    const lines: string[] = [];
    const app = await start(
      {
        config,
        logger: jsonLogger("info", (line) => lines.push(line)),
        stores: db.stores(),
        verify: async () => ({ isValid: true }),
        settle,
        extensionResponses: () => undefined,
        supported: supportedResponse(config.network, Keypair.random().publicKey()),
        metrics: memoryMetrics(),
        lease,
        ...(opts.drain && { drain: opts.drain }),
        ...(opts.reconciliation && { reconciliation: opts.reconciliation }),
      },
      {
        ...(opts.shutdownDeadlineMs !== undefined && {
          shutdownDeadlineMs: opts.shutdownDeadlineMs,
        }),
        ...(opts.shutdownGraceMs !== undefined && { shutdownGraceMs: opts.shutdownGraceMs }),
      },
    );
    const url = `http://127.0.0.1:${app.port}`;
    const events = () => lines.map((line) => (JSON.parse(line) as { event: string }).event);
    return { app, settle, lease, url, events };
  }

  it("answers /settle 503 shutting_down while it drains, then closes and gives the lease up", async () => {
    let drained!: () => void;
    const drain = vi.fn(() => new Promise<void>((resolve) => (drained = resolve)));
    const { app, settle, lease, url, events } = await started({ drain });
    const closing = app.close();
    expect(drain).toHaveBeenCalledTimes(1);
    const refused = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect([refused.status, refused.headers.get("retry-after"), await refused.json()]).toEqual([
      503,
      `${NO_LEASE_RETRY_AFTER_S}`,
      { error: "shutting_down" },
    ]);
    expect(settle).not.toHaveBeenCalled();
    // Still listening, and the lease still held, until the drain ends.
    expect((await fetch(`${url}/supported`)).status).toBe(200);
    expect(lease.release).not.toHaveBeenCalled();
    drained();
    await closing;
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(lease.close).not.toHaveBeenCalled();
    expect(events()).toEqual(expect.arrayContaining(["shutdown_started", "shutdown_drained"]));
    await expect(fetch(`${url}/supported`)).rejects.toThrow();
  });

  it("gives the lease up once the drain ends, without waiting for a sweep under way, and closes after it (0025 decision 23)", async () => {
    let swept!: () => void;
    const reconciliation = {
      reconciled: Promise.resolve(),
      listed: () => true,
      start: vi.fn(),
      close: vi.fn(() => new Promise<void>((resolve) => (swept = resolve))),
    };
    const { app, lease } = await started({ drain: async () => {}, reconciliation });
    let done = false;
    const closing = app.close().then(() => (done = true));
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledTimes(1));
    expect(reconciliation.close).toHaveBeenCalledTimes(1);
    // Sweeps need no lease, but their writes must end before `main()` ends the pools.
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    swept();
    await closing;
  });

  it("gives the lease up at once past a stalled client, and cuts its connection after the grace", async () => {
    const { app, lease, url, events } = await started({
      drain: async () => {},
      shutdownGraceMs: 500,
    });
    const socket = await stalled(url);
    const closing = app.close();
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledTimes(1));
    // The lease went while the stalled client still kept its socket.
    expect(socket.closed).toBe(false);
    await closing;
    // The client sees the cut a moment after the server makes it.
    await vi.waitFor(() => expect(socket.closed).toBe(true));
    expect(lease.close).not.toHaveBeenCalled();
    expect(events()).not.toContain("shutdown_deadline");
  });

  it("stops waiting at its deadline, cuts open connections and leaves the lease to its TTL", async () => {
    const drain = vi.fn(() => new Promise<void>(() => {}));
    const { app, lease, url, events } = await started({ drain, shutdownDeadlineMs: 50 });
    const socket = await stalled(url);
    await app.close();
    // Without `closeAllConnections()` the stalled client would keep its connection.
    await vi.waitFor(() => expect(socket.closed).toBe(true));
    expect(lease.release).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledTimes(1);
    expect(events()).toContain("shutdown_deadline");
    await expect(fetch(`${url}/supported`)).rejects.toThrow();
  });
});
