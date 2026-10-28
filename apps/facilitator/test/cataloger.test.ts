import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { safeBase64Decode } from "@x402/core/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCataloger, type CatalogerDeps } from "../src/catalog/cataloger.js";
import { encodeExtensionResponses } from "../src/http/extension-responses.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementRecord } from "../src/ports/index.js";
import { testDatabase } from "./database.js";
import { startMcpSeller, type McpSeller } from "./mcp-seller.js";
import { startSeller, type Seller } from "./seller.js";

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "10000",
  payTo: "GPAYTO",
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;

const valid = { info: { input: { type: "http", method: "GET" } }, routeTemplate: "/users/:id" };
const DESCRIPTION = "Users by id";

let seller: Seller;

function record(
  bazaar: unknown,
  overrides: Partial<SettlementRecord> = {},
  resource: object = {},
): SettlementRecord {
  const extensions = bazaar === undefined ? {} : { bazaar, "sign-in-with-x": { token: "secret" } };
  return {
    key: "stellar:testnet:GPAYER:1",
    network: "stellar:testnet",
    payer: "GPAYER",
    nonce: "1",
    fingerprint: "f",
    state: "success",
    hashes: ["tx1"],
    version: 1,
    ledger: 100,
    paymentPayload: {
      x402Version: 2,
      resource: { url: `${seller.url}/users/42`, description: DESCRIPTION, ...resource },
      extensions,
    } as unknown as PaymentPayload,
    paymentRequirements: requirements,
    createdAt: 0,
    updatedAt: Date.parse("2026-10-09T10:00:00Z"),
    ...overrides,
  };
}

const db = testDatabase();
beforeEach(async () => {
  await db.empty();
  seller = await startSeller((url) => ({
    x402Version: 2,
    resource: { url, description: DESCRIPTION },
    accepts: [requirements],
    extensions: { bazaar: valid },
  }));
});
afterEach(() => {
  seller.server.close();
});

/** The app clock, one minute after another as tests move it. */
const MINUTE = 60_000;
const START = Date.parse("2026-10-28T10:00:00Z");

function setup(deps: Partial<CatalogerDeps> = {}) {
  const stores = db.stores();
  const store = stores.catalog;
  const metrics = memoryMetrics();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { now: START };
  const cataloger = createCataloger({
    store,
    attempts: stores.catalogAttempts,
    rateLimits: stores.rateLimits,
    metrics,
    logger,
    listLocal: true,
    now: () => clock.now,
    ...deps,
  });
  const list = async () => (await store.list({ limit: 10, offset: 0 })).items;
  const attempts = async () =>
    (
      await db.pool.query<Record<string, unknown>>(
        `SELECT stage, outcome, reason FROM catalog_attempts ORDER BY id`,
      )
    ).rows;
  const counted = (stage: string, outcome: string, reason = "", origin = "settle") =>
    metrics.value("catalog_attempts_total", { origin, stage, outcome, reason });
  return { store, metrics, logger, cataloger, list, attempts, counted, clock };
}

describe("cataloger", () => {
  it("answers the header synchronously, without asking the seller (0063 row 22)", () => {
    const { cataloger } = setup();
    expect(cataloger.extensionResponses(record(valid))).toEqual({
      bazaar: { status: "processing" },
    });
    expect(cataloger.extensionResponses(record({ info: {} }))).toEqual({
      bazaar: { status: "rejected", rejectedReason: "invalid_info" },
    });
    expect(cataloger.extensionResponses(record(undefined))).toBeUndefined();
    expect(cataloger.extensionResponses(record(valid, { state: "pending" }))).toBeUndefined();
    expect(seller.requests).toEqual([]);
  });

  it("encodes the header as base64 JSON that upstream decodes", () => {
    const value = { bazaar: { status: "processing" } } as const;
    expect(JSON.parse(safeBase64Decode(encodeExtensionResponses(value)))).toEqual(value);
  });

  it("lists what the seller's 402 says, with the bazaar block only and the answer's time", async () => {
    const { cataloger, list, counted, clock } = setup();
    clock.now = START + 1_234;
    await cataloger.onSuccess(record(valid), "settle");
    const [entry] = await list();
    expect(entry).toMatchObject({
      resource: `${seller.url}/users/:`,
      description: DESCRIPTION,
      lastUpdated: new Date(START + 1_234).toISOString(),
      accepts: [requirements],
    });
    expect(Object.keys(entry?.extensions ?? {})).toEqual(["bazaar"]);
    expect(seller.requests).toEqual([{ method: "GET", url: "/users/42", body: "" }]);
    expect(counted("seller", "refreshed", "inserted")).toBe(1);
  });

  it("keeps the seller's text and price when another payer's copy says otherwise (row 1)", async () => {
    const { cataloger, list, clock } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    // A minute later, so the per-key limit lets the check run.
    clock.now += MINUTE;
    const outsider = record(
      valid,
      {
        key: "stellar:testnet:GOUTSIDER:1",
        payer: "GOUTSIDER",
        paymentRequirements: { ...requirements, amount: "1" },
      },
      { description: "Pwned" },
    );
    await cataloger.onSuccess(outsider, "settle");
    const [entry] = await list();
    expect(entry).toMatchObject({ description: DESCRIPTION, accepts: [requirements] });
    expect(seller.requests).toHaveLength(2);
  });

  it("asks the seller only when the copy differs, at most once a minute per key (row 2)", async () => {
    const { cataloger, attempts, counted, clock } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.onSuccess(record(valid), "settle");
    expect(seller.requests).toHaveLength(1);
    expect(counted("payment", "unchanged")).toBe(1);

    const changed = record(valid, {}, { description: "Changed" });
    await cataloger.onSuccess(changed, "settle");
    expect(seller.requests).toHaveLength(1);
    expect(counted("payment", "over_budget", "key")).toBe(1);

    clock.now += MINUTE;
    await cataloger.onSuccess(changed, "settle");
    expect(seller.requests).toHaveLength(2);
    expect(await attempts()).toEqual([
      { stage: "seller", outcome: "refreshed", reason: "inserted" },
      { stage: "payment", outcome: "unchanged", reason: null },
      { stage: "payment", outcome: "over_budget", reason: "key" },
      { stage: "seller", outcome: "refreshed", reason: "updated" },
    ]);
  });

  it("checks at most so many listings a minute per host and in all (row 3)", async () => {
    // No template, so each path is a listing of its own.
    const at = (path: string) => record({ info: valid.info }, {}, { url: `${seller.url}/${path}` });
    const perHost = setup({ checksPerMinute: { host: 2, all: 100 } });
    for (const path of ["a", "b", "c"]) await perHost.cataloger.onSuccess(at(path), "settle");
    expect(seller.requests).toHaveLength(2);
    expect(perHost.counted("payment", "over_budget", "host")).toBe(1);
    expect(perHost.logger.info).toHaveBeenCalledWith(
      "catalog_check_skipped",
      expect.objectContaining({ budget: "host" }),
    );

    // The next minute's windows, so the per-host count above doesn't apply.
    const all = setup({ checksPerMinute: { host: 100, all: 1 }, now: () => START + MINUTE });
    for (const path of ["d", "e"]) await all.cataloger.onSuccess(at(path), "settle");
    expect(all.counted("payment", "over_budget", "all")).toBe(1);
  });

  it("sends the listing's example input: a GET's query, a POST's body (row 4)", async () => {
    const { cataloger } = setup();
    const get = { info: { input: { type: "http", method: "GET", queryParams: { city: "Waw" } } } };
    const post = {
      info: { input: { type: "http", method: "POST", bodyType: "json", body: { n: 1 } } },
    };
    const bare = { info: { input: { type: "http", method: "POST", bodyType: "json", body: {} } } };
    seller.paymentRequired = (url) => ({
      x402Version: 2,
      resource: { url },
      accepts: [requirements],
      extensions: { bazaar: url.endsWith("/get") ? get : url.endsWith("/post") ? post : bare },
    });
    await cataloger.onSuccess(record(get, {}, { url: `${seller.url}/get` }), "settle");
    await cataloger.onSuccess(record(post, {}, { url: `${seller.url}/post` }), "settle");
    await cataloger.onSuccess(record(bare, {}, { url: `${seller.url}/bare` }), "settle");
    expect(seller.requests).toEqual([
      { method: "GET", url: "/get?city=Waw", body: "" },
      { method: "POST", url: "/post", body: '{"n":1}' },
      { method: "POST", url: "/bare", body: "{}" },
    ]);
  });

  it.each([
    ["not a 402", { status: 200 }, "not_402"],
    ["a 402 without terms", { status: 402, body: {} as PaymentRequired }, "unreadable_402"],
  ] as const)(
    "creates nothing and changes nothing when the seller answers %s (row 6)",
    async (_name, answer, reason) => {
      const { cataloger, list, counted, logger, clock } = setup();
      await cataloger.onSuccess(record(valid), "settle");
      const before = await list();
      seller.reply = async () => answer;
      clock.now += MINUTE;
      await cataloger.onSuccess(record(valid, {}, { description: "Changed" }), "settle");
      expect(await list()).toEqual(before);
      expect(counted("seller", "not_askable", reason)).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        "catalog_rejected",
        expect.objectContaining({ stage: "seller", reason, payTo: "GPAYTO", payer: "GPAYER" }),
      );
    },
  );

  it("does not ask a private address, an mcp listing, or a seller past the timeout (row 6)", async () => {
    const { cataloger, list, counted } = setup({ sellerTimeoutMs: 100 });
    await cataloger.onSuccess(
      record({ info: valid.info }, {}, { url: "http://10.255.255.1/x" }),
      "settle",
    );
    expect(counted("seller", "not_askable", "unsafe_url")).toBe(1);

    // Upstream's default resource URL names the tool, not the server that has it.
    const tool = { info: { input: { type: "mcp", toolName: "weather", inputSchema: {} } } };
    await cataloger.onSuccess(record(tool, {}, { url: "mcp://tool/weather" }), "settle");
    expect(counted("seller", "not_askable", "mcp_tool_url")).toBe(1);

    seller.reply = () => new Promise(() => {});
    await cataloger.onSuccess(record(valid), "settle");
    expect(counted("seller", "not_askable", "upstream_error")).toBe(1);
    expect(await list()).toEqual([]);
  });

  it("stores only the offers to the key's payTo, replacing the stored ones (row 7)", async () => {
    const { cataloger, list, counted, clock } = setup();
    const other = { ...requirements, asset: "COTHER" };
    seller.paymentRequired = (url) => ({
      x402Version: 2,
      resource: { url, description: DESCRIPTION },
      accepts: [requirements, other, { ...requirements, payTo: "GELSEWHERE" }],
      extensions: { bazaar: valid },
    });
    await cataloger.onSuccess(record(valid), "settle");
    expect((await list())[0]?.accepts).toEqual([requirements, other]);

    seller.paymentRequired = (url) => ({
      x402Version: 2,
      resource: { url, description: "Now one asset" },
      accepts: [other],
      extensions: { bazaar: valid },
    });
    clock.now += MINUTE;
    await cataloger.onSuccess(record(valid, {}, { description: "Now one asset" }), "settle");
    expect((await list())[0]?.accepts).toEqual([other]);

    seller.paymentRequired = (url) => ({
      x402Version: 2,
      resource: { url },
      accepts: [{ ...requirements, payTo: "GELSEWHERE" }],
      extensions: { bazaar: valid },
    });
    clock.now += MINUTE;
    await cataloger.onSuccess(record(valid, {}, { description: "Other payTo" }), "settle");
    expect(counted("seller", "other_pay_to")).toBe(1);
    expect((await list())[0]?.accepts).toEqual([other]);
  });

  it("keeps an offer's seven fields and logs how many were dropped (row 8)", async () => {
    const { cataloger, list, logger } = setup();
    seller.paymentRequired = (url) => ({
      x402Version: 2,
      resource: { url, description: DESCRIPTION },
      accepts: [{ ...requirements, resource: url, description: "v1" } as PaymentRequirements],
      extensions: { bazaar: valid },
    });
    await cataloger.onSuccess(record(valid), "settle");
    expect((await list())[0]?.accepts).toEqual([requirements]);
    expect(logger.info).toHaveBeenCalledWith(
      "catalog_upserted",
      expect.objectContaining({ droppedFields: 2 }),
    );
  });

  it("refuses a seller listing over a limit as too_large, naming the field (row 9)", async () => {
    const { cataloger, list, counted, logger } = setup();
    seller.paymentRequired = (url) => ({
      x402Version: 2,
      resource: { url, description: DESCRIPTION },
      accepts: [{ ...requirements, extra: { pad: "x".repeat(5_000) } }],
      extensions: { bazaar: valid },
    });
    expect(setup().cataloger.extensionResponses(record(valid))).toEqual({
      bazaar: { status: "processing" },
    });
    await cataloger.onSuccess(record(valid), "settle");
    expect(await list()).toEqual([]);
    expect(counted("seller", "too_large")).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "catalog_rejected",
      expect.objectContaining({ detail: "accepts.extra", bytes: 5_010 }),
    );
    const { rows } = await db.pool.query(`SELECT field_bytes FROM catalog_attempts`);
    expect(rows).toEqual([{ field_bytes: 5_010 }]);
  });

  it("keeps the result of the check that started later, whichever answers first (row 10)", async () => {
    // The two checks fall in two minutes' windows, so the per-key limit lets both run.
    const { cataloger, list, clock } = setup();
    clock.now = START + MINUTE - 1;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    seller.reply = async (request) => {
      calls += 1;
      const description = calls === 1 ? "older" : "newer";
      if (calls === 1) await firstHeld;
      const body = seller.paymentRequired(`${seller.url}${request.url}`);
      return { status: 402, body: { ...body, resource: { ...body.resource, description } } };
    };
    const first = cataloger.onSuccess(record(valid, {}, { description: "older" }), "settle");
    await vi.waitFor(() => expect(calls).toBe(1));
    clock.now = START + MINUTE + 1;
    await cataloger.onSuccess(record(valid, {}, { description: "newer" }), "settle");
    releaseFirst();
    await first;
    expect((await list())[0]?.description).toBe("newer");
  });

  it("keeps a row per attempt with its key, payer and transaction (row 23)", async () => {
    const { cataloger } = setup();
    await cataloger.onSuccess(record({ info: {} }), "settle");
    await cataloger.onSuccess(record(valid), "settle");
    const { rows } = await db.pool.query(
      `SELECT at, network, pay_to, method, resource_url, url, payer, transaction, stage, outcome,
              reason, detail, field_bytes, content_hash
       FROM catalog_attempts ORDER BY id`,
    );
    expect(rows).toEqual([
      {
        at: String(START),
        network: "stellar:testnet",
        pay_to: "GPAYTO",
        method: null,
        resource_url: null,
        url: `${seller.url}/users/42`,
        payer: "GPAYER",
        transaction: "tx1",
        stage: "payment",
        outcome: "rejected",
        reason: "invalid_info",
        detail: expect.any(String),
        field_bytes: null,
        content_hash: null,
      },
      {
        at: String(START),
        network: "stellar:testnet",
        pay_to: "GPAYTO",
        method: "GET",
        resource_url: `${seller.url}/users/:`,
        url: `${seller.url}/users/42`,
        payer: "GPAYER",
        transaction: "tx1",
        stage: "seller",
        outcome: "refreshed",
        reason: "inserted",
        detail: null,
        field_bytes: null,
        content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("logs and counts an attempt row it could not write, and still lists (row 23)", async () => {
    const stores = db.stores();
    vi.spyOn(stores.catalogAttempts, "record").mockRejectedValue(new Error("down"));
    const { cataloger, list, metrics, logger } = setup({ attempts: stores.catalogAttempts });
    await cataloger.onSuccess(record(valid), "settle");
    expect(await list()).toHaveLength(1);
    expect(metrics.value("catalog_attempt_write_failures_total", { origin: "settle" })).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "catalog_attempt_write_failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it.each([
    ["stellar:pubnet", false, { status: "rejected", rejectedReason: "resource_not_public" }, 0],
    ["stellar:testnet", false, { status: "rejected", rejectedReason: "resource_not_public" }, 0],
    ["stellar:testnet", true, { status: "processing" }, 1],
  ] as const)(
    "on %s with listLocal %s, a local listing gets %j and %i entries (0054)",
    async (network, listLocal, header, listed) => {
      const { cataloger, logger, list, counted } = setup({ listLocal });
      const local = record(valid, {
        key: `${network}:GPAYER:1`,
        network,
        paymentRequirements: { ...requirements, network },
      });
      seller.paymentRequired = (url) => ({
        x402Version: 2,
        resource: { url },
        accepts: [{ ...requirements, network }],
        extensions: { bazaar: valid },
      });
      expect(cataloger.extensionResponses(local)).toEqual({ bazaar: header });
      await cataloger.onSuccess(local, "settle");
      expect(await list()).toHaveLength(listed);
      expect(counted("payment", "rejected", "resource_not_public")).toBe(1 - listed);
      expect(seller.requests).toHaveLength(listed);
      if (listed === 0)
        expect(logger.info).toHaveBeenCalledWith(
          "catalog_rejected",
          expect.objectContaining({
            reason: "resource_not_public",
            detail: expect.any(String),
            url: `${seller.url}/users/42`,
            payTo: "GPAYTO",
            payer: "GPAYER",
          }),
        );
    },
  );

  it("never rejects: a failing or hung store, or a failing library, is logged and counted", async () => {
    const failing = setup();
    vi.spyOn(failing.store, "upsert").mockRejectedValue(new Error("down"));
    await expect(failing.cataloger.onSuccess(record(valid), "settle")).resolves.toBeUndefined();
    expect(failing.metrics.value("catalog_upsert_failures_total", { origin: "settle" })).toBe(1);

    const hung = setup({ upsertTimeoutMs: 5, now: () => START + MINUTE });
    vi.spyOn(hung.store, "upsert").mockReturnValue(new Promise(() => {}));
    await hung.cataloger.onSuccess(record(valid), "resolved");
    await hung.cataloger.drain();
    expect(hung.metrics.value("catalog_upsert_failures_total", { origin: "resolved" })).toBe(1);

    const boom = () => {
      throw new Error("boom");
    };
    const broken = setup({
      bazaar: { validate: boom, normalize: boom, toExtensionResponses: boom },
      logger: { debug: boom, info: boom, warn: boom, error: boom },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(broken.cataloger.extensionResponses(record(valid))).toEqual({
      bazaar: { status: "rejected", rejectedReason: "internal_error" },
    });
    await expect(broken.cataloger.onSuccess(record(valid), "settle")).resolves.toBeUndefined();

    const internal = setup({
      bazaar: {
        validate: () => ({ ok: false, reason: "internal_error" }),
        normalize: boom,
        toExtensionResponses: boom,
      },
    });
    await internal.cataloger.onSuccess(record(valid), "resolved");
    expect(
      internal.metrics.value("catalog_internal_errors_total", {
        stage: "validate",
        origin: "resolved",
      }),
    ).toBe(1);
    expect(internal.logger.info).not.toHaveBeenCalled();
  });
});

describe("cataloger, an MCP listing (0063 rows 5, 18)", () => {
  const tool = {
    info: {
      input: {
        type: "mcp",
        toolName: "weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        example: { city: "Waw" },
      },
    },
  };
  // Upstream's wrapper names the tool in `resource.url` (`mcp://tool/<name>`) unless told otherwise.
  const terms: PaymentRequired = {
    x402Version: 2,
    resource: { url: "mcp://tool/weather", description: "Weather by city" },
    accepts: [requirements],
    extensions: { bazaar: tool },
  };
  let mcp: McpSeller;
  afterEach(() => {
    mcp.server.closeAllConnections();
    mcp.server.close();
  });
  const paid = (overrides: Partial<SettlementRecord> = {}, resource: object = {}) =>
    record(tool, overrides, { url: mcp.url, description: "Weather by city", ...resource });
  const methods = () => mcp.messages.map((message) => message.method);

  it("lists the tool from its unpaid tools/call answer, sent with the example arguments (row 5)", async () => {
    mcp = await startMcpSeller(() => terms);
    const { cataloger, list, counted } = setup();
    await cataloger.onSuccess(paid({}, { description: "Pwned" }), "settle");
    const [entry] = await list();
    expect(entry).toMatchObject({
      resource: mcp.url,
      type: "mcp",
      description: "Weather by city",
      accepts: [requirements],
    });
    expect(methods()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    const call = mcp.messages.at(-1)?.params;
    expect(call).toMatchObject({ name: "weather", arguments: { city: "Waw" } });
    expect(JSON.stringify(call)).not.toContain("x402/payment");
    expect(counted("seller", "refreshed", "inserted")).toBe(1);
  });

  it("tells a tool the server doesn't list apart from a server that is down (row 18)", async () => {
    mcp = await startMcpSeller(() => terms, { tools: ["forecast"] });
    const { cataloger, list, counted, clock } = setup();
    await cataloger.onSuccess(paid(), "settle");
    expect(counted("seller", "not_askable", "no_tool")).toBe(1);
    expect(methods()).not.toContain("tools/call");

    mcp.server.closeAllConnections();
    mcp.server.close();
    clock.now += MINUTE;
    await cataloger.onSuccess(paid(), "settle");
    expect(counted("seller", "not_askable", "upstream_error")).toBe(1);
    expect(await list()).toEqual([]);
  });

  it.each([
    ["only as text, without structuredContent", { textOnly: true }],
    ["in structuredContent the tool's output schema doesn't describe", { outputSchema: true }],
  ])("reads the 402 terms a seller sends %s", async (_name, options) => {
    mcp = await startMcpSeller(() => terms, options);
    const { cataloger, list, counted } = setup();
    await cataloger.onSuccess(paid(), "settle");
    expect(counted("seller", "refreshed", "inserted")).toBe(1);
    expect(await list()).toHaveLength(1);
  });

  it("creates nothing when the tool runs without asking for a payment (row 6)", async () => {
    mcp = await startMcpSeller(() => "free");
    const { cataloger, list, counted } = setup();
    await cataloger.onSuccess(paid(), "settle");
    expect(counted("seller", "not_askable", "not_402")).toBe(1);
    expect(await list()).toEqual([]);
  });

  it("closes the seller's event stream once the check is done", async () => {
    mcp = await startMcpSeller(() => terms);
    const { cataloger } = setup();
    await cataloger.onSuccess(paid(), "settle");
    await vi.waitFor(() => expect(mcp.openStreams()).toBe(0), { timeout: 1_000 });
  });
});
