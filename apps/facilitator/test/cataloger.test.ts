import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { safeBase64Decode } from "@x402/core/utils";
import { describe, expect, it, vi } from "vitest";
import { MemoryCatalogStore } from "../src/adapters/memory.js";
import { createCataloger, type CatalogerDeps } from "../src/catalog/cataloger.js";
import { encodeExtensionResponses } from "../src/http/extension-responses.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementRecord } from "../src/ports/index.js";

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
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://seller.example/users/42" },
      extensions,
    } as unknown as PaymentPayload,
    paymentRequirements: requirements,
    createdAt: 0,
    updatedAt: Date.parse("2026-10-09T10:00:00Z"),
    ...overrides,
  };
}

const valid = { info: { input: { type: "http", method: "GET" } }, routeTemplate: "/users/:id" };

function setup(deps: Partial<CatalogerDeps> = {}) {
  const store = new MemoryCatalogStore();
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
      resource: "https://seller.example/users/:",
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

  it("keeps a newer listing when an older success arrives late", async () => {
    const { cataloger, metrics } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.onSuccess(record(valid, { updatedAt: 0 }), "resolved");
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

  it("never rejects: a failing store or library is logged and counted", async () => {
    const failing = setup();
    vi.spyOn(failing.store, "upsert").mockRejectedValue(new Error("down"));
    await expect(failing.cataloger.onSuccess(record(valid), "settle")).resolves.toBeUndefined();
    expect(failing.metrics.value("catalog_upsert_failures_total", { origin: "settle" })).toBe(1);

    const boom = () => {
      throw new Error("boom");
    };
    const broken = setup({
      bazaar: { validate: boom, normalize: boom, toExtensionResponses: boom },
    });
    expect(broken.cataloger.extensionResponses(record(valid))).toEqual({
      bazaar: { status: "rejected", rejectedReason: "internal_error" },
    });
    await expect(broken.cataloger.onSuccess(record(valid), "settle")).resolves.toBeUndefined();
    await broken.cataloger.drain();
    expect(broken.metrics.value("catalog_internal_errors_total", { stage: "validate" })).toBe(1);
  });
});
