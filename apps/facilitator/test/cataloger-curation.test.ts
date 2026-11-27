import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCataloger, type CatalogerDeps } from "../src/catalog/cataloger.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementRecord } from "../src/ports/index.js";
import { testDatabase } from "./database.js";
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

function record(bazaar: unknown, resource: object = {}): SettlementRecord {
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
      resource: { url: `${seller.url}/users/42`, description: DESCRIPTION, ...resource },
      extensions: { bazaar },
    } as unknown as PaymentPayload,
    paymentRequirements: requirements,
    createdAt: 0,
    updatedAt: Date.parse("2026-10-09T10:00:00Z"),
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

const MINUTE = 60_000;
const START = Date.parse("2026-10-28T10:00:00Z");

function setup(deps: Partial<CatalogerDeps> = {}) {
  const stores = db.stores();
  const curation = {
    refresh: vi.fn<(network: string, url: string, payTo: string) => Promise<void>>(async () => {}),
  };
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { now: START };
  const cataloger = createCataloger({
    store: stores.catalog,
    attempts: stores.catalogAttempts,
    rateLimits: stores.rateLimits,
    metrics: memoryMetrics(),
    logger,
    listLocal: true,
    now: () => clock.now,
    curation,
    ...deps,
  });
  const list = async () => (await stores.catalog.list({ limit: 10, offset: 0 }, Date.now())).items;
  const attempts = async () =>
    (
      await db.pool.query<Record<string, unknown>>(
        `SELECT stage, outcome, reason FROM catalog_attempts ORDER BY id`,
      )
    ).rows;
  return { cataloger, curation, clock, list, attempts };
}

describe("cataloger: curation", () => {
  it("refreshes the curation of a listing the check inserted, with the URL the payment sent", async () => {
    const { cataloger, curation } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.drain();
    expect(curation.refresh.mock.calls).toEqual([
      ["stellar:testnet", `${seller.url}/users/42`, "GPAYTO"],
    ]);
  });

  it("refreshes again on a payment whose copy is unchanged, without asking the seller", async () => {
    const { cataloger, curation } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.drain();
    expect(seller.requests).toHaveLength(1);
    expect(curation.refresh.mock.calls).toEqual([
      ["stellar:testnet", `${seller.url}/users/42`, "GPAYTO"],
      ["stellar:testnet", `${seller.url}/users/42`, "GPAYTO"],
    ]);
  });

  it("refreshes on a payment whose check updated the listing", async () => {
    const { cataloger, curation, clock } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    clock.now += MINUTE;
    await cataloger.onSuccess(record(valid, { description: "Changed" }), "settle");
    await cataloger.drain();
    expect(seller.requests).toHaveLength(2);
    expect(curation.refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes for a payment over the check budget, apart from the seller check", async () => {
    const { cataloger, curation } = setup();
    await cataloger.onSuccess(record(valid), "settle");
    // Within the minute: the per-key budget refuses the check of a changed copy.
    await cataloger.onSuccess(record(valid, { description: "Changed" }), "settle");
    await cataloger.drain();
    expect(seller.requests).toHaveLength(1);
    expect(curation.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for a listing that is not in the catalog", async () => {
    const { cataloger, curation, list } = setup();
    // The seller answers without terms: nothing is listed.
    seller.reply = async () => ({ status: 200 });
    await cataloger.onSuccess(record(valid), "settle");
    await cataloger.drain();
    expect(await list()).toEqual([]);
    expect(curation.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh for a payment whose listing is rejected", async () => {
    const { cataloger, curation, list } = setup();
    await cataloger.onSuccess(record({ info: {} }), "settle");
    await cataloger.drain();
    expect(await list()).toEqual([]);
    expect(curation.refresh).not.toHaveBeenCalled();
  });

  it("still records the attempt and lists when the refresh rejects", async () => {
    const { cataloger, curation, list, attempts } = setup();
    curation.refresh.mockRejectedValue(new Error("curation down"));
    await expect(cataloger.onSuccess(record(valid), "settle")).resolves.toBeUndefined();
    await cataloger.drain();
    expect(curation.refresh).toHaveBeenCalledTimes(1);
    expect(await list()).toHaveLength(1);
    expect(await attempts()).toEqual([
      { stage: "seller", outcome: "refreshed", reason: "inserted" },
    ]);
  });
});
