import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCataloger } from "../src/catalog/cataloger.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { testDatabase } from "./database.js";
import { startSeller, type Seller } from "./seller.js";

const offer = (overrides: Partial<PaymentRequirements> = {}) =>
  ({
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CASSET",
    amount: "10000",
    payTo: "GPAYTO",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  }) as PaymentRequirements;

const GET = { info: { input: { type: "http", method: "GET" } } };
const POST = { info: { input: { type: "http", method: "POST", body: { city: "Warsaw" } } } };

let seller: Seller;
let accepts: PaymentRequirements[];
let bazaar: unknown;

const db = testDatabase();
beforeEach(async () => {
  await db.empty();
  accepts = [offer()];
  bazaar = GET;
  seller = await startSeller((url) => ({
    x402Version: 2,
    resource: { url, description: "Weather" },
    accepts,
    extensions: { bazaar },
  }));
});
afterEach(() => {
  seller.server.close();
});

function setup(now?: () => number) {
  const stores = db.stores();
  const metrics = memoryMetrics();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cataloger = createCataloger({
    store: stores.catalog,
    attempts: stores.catalogAttempts,
    rateLimits: stores.rateLimits,
    metrics,
    logger,
    listLocal: true,
    now,
  });
  const rows = async () =>
    (
      await db.pool.query<Record<string, unknown>>(
        `SELECT network, pay_to, method, ledger FROM catalog ORDER BY seq`,
      )
    ).rows;
  const attempts = async () =>
    (
      await db.pool.query<Record<string, unknown>>(
        `SELECT payer, stage, outcome FROM catalog_attempts ORDER BY id`,
      )
    ).rows;
  return { cataloger, metrics, rows, attempts };
}

describe("cataloger.seed (0155)", () => {
  it("lists a resource from its seller's 402, with no settlement behind it", async () => {
    const { cataloger, rows, attempts, metrics } = setup();
    const { results } = await cataloger.seed(`${seller.url}/weather`, "GET");
    expect(results).toEqual([
      {
        url: `${seller.url}/weather`,
        method: "GET",
        network: "stellar:testnet",
        payTo: "GPAYTO",
        outcome: "refreshed",
        reason: "inserted",
      },
    ]);
    expect(await rows()).toEqual([
      { network: "stellar:testnet", pay_to: "GPAYTO", method: "GET", ledger: null },
    ]);
    expect(await attempts()).toEqual([{ payer: null, stage: "seller", outcome: "refreshed" }]);
    // The 402 that named the listing is the check's answer: the seller is asked once.
    expect(seller.requests).toHaveLength(1);
    const labels = { origin: "seed", stage: "seller", outcome: "refreshed", reason: "inserted" };
    expect(metrics.value("catalog_attempts_total", labels)).toBe(1);
  });

  it("keeps the ledger of a listing a settlement wrote when the seed checks it again", async () => {
    const { cataloger, rows } = setup();
    await cataloger.seed(`${seller.url}/weather`, "GET");
    await db.pool.query("UPDATE catalog SET ledger = 100, checked_at = 0");
    await cataloger.seed(`${seller.url}/weather`, "GET");
    expect(await rows()).toMatchObject([{ ledger: "100" }]);
  });

  it("dates a listing confirmed by the first 402 at that request, not at the check's turn", async () => {
    accepts = [offer(), offer({ network: "stellar:pubnet", payTo: "GPUBNET" })];
    let clock = 1_000_000;
    const { cataloger } = setup(() => (clock += 1_000));
    await cataloger.seed(`${seller.url}/weather`, "GET");
    const dated = await db.pool.query<{ checked_at: string; last: string }>(
      `SELECT checked_at, resource->>'lastUpdated' AS last FROM catalog ORDER BY seq`,
    );
    const asked = dated.rows[0]!.checked_at;
    expect(dated.rows.map((row) => row.checked_at)).toEqual([asked, asked]);
    expect(dated.rows.map((row) => row.last)).toEqual([
      new Date(Number(asked)).toISOString(),
      new Date(Number(asked)).toISOString(),
    ]);
  });

  it("asks again with the method the seller's 402 declares, and lists under it", async () => {
    bazaar = POST;
    const { cataloger, rows } = setup();
    const {
      results: [result],
      requests,
    } = await cataloger.seed(`${seller.url}/weather`, "GET");
    expect(requests).toBe(2);
    expect(result).toMatchObject({ method: "POST", outcome: "refreshed" });
    expect(seller.requests).toEqual([
      { method: "GET", url: "/weather", body: "" },
      { method: "POST", url: "/weather", body: '{"city":"Warsaw"}' },
    ]);
    expect(await rows()).toMatchObject([{ method: "POST" }]);
  });

  it("lists once per Stellar account among the offers, and skips other networks", async () => {
    accepts = [
      offer(),
      offer({ network: "stellar:pubnet", payTo: "GPUBNET" }),
      offer({ payTo: "GPAYTO", amount: "20000" }),
      offer({ network: "eip155:8453", payTo: "0xSELLER" }),
    ];
    const { cataloger, rows } = setup();
    const { results } = await cataloger.seed(`${seller.url}/weather`, "GET");
    expect(seller.requests).toHaveLength(1);
    expect(results.map((result) => [result.network, result.payTo, result.outcome])).toEqual([
      ["stellar:testnet", "GPAYTO", "refreshed"],
      ["stellar:pubnet", "GPUBNET", "refreshed"],
    ]);
    expect(await rows()).toMatchObject([
      { network: "stellar:testnet", pay_to: "GPAYTO" },
      { network: "stellar:pubnet", pay_to: "GPUBNET" },
    ]);
  });

  it("reports a seller that doesn't answer with a 402, and lists nothing", async () => {
    seller.reply = async () => ({ status: 404 });
    const { cataloger, rows } = setup();
    expect((await cataloger.seed(`${seller.url}/gone`, "GET")).results).toEqual([
      {
        url: `${seller.url}/gone`,
        method: "GET",
        outcome: "not_askable",
        reason: "not_402",
        detail: "status 404",
      },
    ]);
    expect(await rows()).toEqual([]);
  });

  it("reports a 402 with no Stellar offer", async () => {
    accepts = [offer({ network: "eip155:8453", payTo: "0xSELLER" })];
    const { cataloger } = setup();
    expect((await cataloger.seed(`${seller.url}/weather`, "GET")).results).toMatchObject([
      { outcome: "not_askable", reason: "no_stellar_offer" },
    ]);
  });

  it("reports a 402 whose listing breaks a rule, naming the rule", async () => {
    bazaar = { info: {} };
    const { cataloger, rows } = setup();
    expect((await cataloger.seed(`${seller.url}/weather`, "GET")).results).toMatchObject([
      { network: "stellar:testnet", payTo: "GPAYTO", outcome: "refused" },
    ]);
    expect(await rows()).toEqual([]);
  });
});
