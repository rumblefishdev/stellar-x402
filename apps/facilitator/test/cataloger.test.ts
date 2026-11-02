import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { safeBase64Decode } from "@x402/core/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCataloger, type CatalogerDeps } from "../src/catalog/cataloger.js";
import { encodeExtensionResponses } from "../src/http/extension-responses.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementRecord } from "../src/ports/index.js";
import { testDatabase } from "./database.js";

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "100",
  payTo: "GPAYTO",
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;

function record(bazaar: unknown, overrides: Partial<SettlementRecord> = {}): SettlementRecord {
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
    reopened: 0,
    ledger: 100,
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://seller.example.com/users/42" },
      extensions,
    } as unknown as PaymentPayload,
    paymentRequirements: requirements,
    createdAt: 0,
    updatedAt: Date.parse("2026-10-09T10:00:00Z"),
    ...overrides,
  };
}

const valid = { info: { input: { type: "http", method: "GET" } }, routeTemplate: "/users/:id" };

const db = testDatabase();
beforeEach(db.empty);

function setup(deps: Partial<CatalogerDeps> = {}) {
  const store = db.stores().catalog;
  const metrics = memoryMetrics();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cataloger = createCataloger({ store, metrics, logger, ...deps });
  const list = async () => (await store.list({ limit: 10, offset: 0 })).items;
  return { store, metrics, logger, cataloger, list };
}

describe("cataloger", () => {
  it("answers the header synchronously: processing, rejected or none", () => {
    const { cataloger } = setup();
    expect(cataloger.extensionResponses(record(valid))).toEqual({
      bazaar: { status: "processing" },
    });
    expect(cataloger.extensionResponses(record({ info: {} }))).toEqual({
      bazaar: { status: "rejected", rejectedReason: "invalid_info" },
    });
    expect(cataloger.extensionResponses(record(undefined))).toBeUndefined();
    expect(cataloger.extensionResponses(record(valid, { state: "pending" }))).toBeUndefined();
  });

  it("encodes the header as base64 JSON that upstream decodes", () => {
    const value = { bazaar: { status: "processing" } } as const;
    expect(JSON.parse(safeBase64Decode(encodeExtensionResponses(value)))).toEqual(value);
  });

  it("catalogs a success once per key, with the bazaar block only and the record's time", async () => {
    const { cataloger, metrics, list } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.onSuccess(record(valid), "settle");
    const [entry] = await list();
    expect(entry).toMatchObject({
      resource: "https://seller.example.com/users/:",
      lastUpdated: "2026-10-09T10:00:00.000Z",
      accepts: [requirements],
    });
    expect(Object.keys(entry?.extensions ?? {})).toEqual(["bazaar"]);
    expect(metrics.value("catalog_upserts_total", { origin: "settle", outcome: "inserted" })).toBe(
      1,
    );
    expect(metrics.value("catalog_upserts_total", { origin: "settle", outcome: "updated" })).toBe(
      1,
    );
  });

  it("catalogs what upstream 2.28 servers send by default with listLocal (0053, 0054)", async () => {
    const { cataloger, list } = setup({ listLocal: true });
    // `@x402/core` sends `mimeType` and `description` as `|| ""`; `@x402/mcp` names a tool
    // `mcp://tool/<name>` with `application/json`.
    const http = record(
      { info: { input: { type: "http", method: "GET" } } },
      {
        paymentPayload: {
          x402Version: 2,
          resource: { url: "http://localhost:4022/exact/stellar", description: "", mimeType: "" },
          extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
        } as unknown as PaymentPayload,
      },
    );
    const tool = { info: { input: { type: "mcp", toolName: "exact_stellar", inputSchema: {} } } };
    const mcp = record(tool, {
      key: "stellar:testnet:GPAYER:2",
      paymentPayload: {
        x402Version: 2,
        resource: { url: "mcp://tool/exact_stellar", mimeType: "application/json" },
        extensions: { bazaar: tool },
      } as unknown as PaymentPayload,
    });
    expect(cataloger.extensionResponses(http)).toEqual({ bazaar: { status: "processing" } });
    expect(cataloger.extensionResponses(mcp)).toEqual({ bazaar: { status: "processing" } });
    await cataloger.onSuccess(http, "settle");
    await cataloger.onSuccess(mcp, "settle");
    const entries = await list();
    expect(entries.map((entry) => entry.resource)).toEqual([
      "http://localhost:4022/exact/stellar",
      "mcp://tool/exact_stellar",
    ]);
    expect(entries[0]).not.toHaveProperty("mimeType");
    expect(entries[0]).not.toHaveProperty("description");
    expect(entries[1]?.mimeType).toBe("application/json");
  });

  it.each([
    ["stellar:pubnet", false, { status: "rejected", rejectedReason: "resource_not_public" }, 0],
    ["stellar:testnet", false, { status: "rejected", rejectedReason: "resource_not_public" }, 0],
    ["stellar:testnet", true, { status: "processing" }, 1],
  ] as const)(
    "on %s with listLocal %s, a localhost listing gets %j and %i entries (0054)",
    async (network, listLocal, header, listed) => {
      const { cataloger, metrics, logger, list } = setup({ listLocal });
      const local = record(
        { info: { input: { type: "http", method: "GET" } } },
        {
          key: `${network}:GPAYER:1`,
          network,
          paymentRequirements: { ...requirements, network },
          paymentPayload: {
            x402Version: 2,
            resource: { url: "http://localhost:4022/exact/stellar" },
            extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
          } as unknown as PaymentPayload,
        },
      );
      expect(cataloger.extensionResponses(local)).toEqual({ bazaar: header });
      await cataloger.onSuccess(local, "settle");
      expect(await list()).toHaveLength(listed);
      expect(
        metrics.value("catalog_rejections_total", {
          origin: "settle",
          reason: "resource_not_public",
        }),
      ).toBe(1 - listed);
      if (listed === 0)
        expect(logger.info).toHaveBeenCalledWith(
          "catalog_rejected",
          expect.objectContaining({ reason: "resource_not_public", detail: expect.any(String) }),
        );
    },
  );

  it("keeps a newer listing when a success from an earlier ledger resolves later", async () => {
    const { cataloger, metrics } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.onSuccess(record(valid, { ledger: 99, updatedAt: Date.now() }), "resolved");
    expect(metrics.value("catalog_upserts_total", { origin: "resolved", outcome: "stale" })).toBe(
      1,
    );
  });

  it("writes nothing for a rejected listing, and counts it", async () => {
    const { cataloger, metrics, list } = setup();
    await cataloger.onSuccess(record({ info: {} }), "settle");
    expect(await list()).toEqual([]);
    expect(
      metrics.value("catalog_rejections_total", { origin: "settle", reason: "invalid_info" }),
    ).toBe(1);
  });

  it("never rejects: a failing or hung store, or a failing library, is logged and counted", async () => {
    const failing = setup();
    vi.spyOn(failing.store, "upsert").mockRejectedValue(new Error("down"));
    await expect(failing.cataloger.onSuccess(record(valid), "settle")).resolves.toBeUndefined();
    expect(failing.metrics.value("catalog_upsert_failures_total", { origin: "settle" })).toBe(1);

    const hung = setup({ upsertTimeoutMs: 5 });
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
