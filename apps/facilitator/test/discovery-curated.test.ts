import { Keypair } from "@stellar/stellar-sdk";
import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import type { StellarNetwork } from "@stellar-x402/config";
import type {
  DiscoveryResource,
  DiscoveryResourcesResponse,
  SearchDiscoveryResourcesResponse,
} from "@x402/extensions/bazaar";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresCurationStore } from "../src/adapters/postgres-curation.js";
import { parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { Stores } from "../src/ports/index.js";
import type { Settle } from "../src/settlement/settle.js";
import type { Verify } from "../src/settlement/verify.js";
import { start, type Started } from "../src/start.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";
import { noSearchModel } from "./vectors.js";

const PAY_A = Keypair.random().publicKey();
const PAY_B = Keypair.random().publicKey();
// The app clock: a proof older than 30 days would not count.
const CHECKED_AT = Date.now();

/** A listing the cataloger wrote, its words holding "weather". */
async function listing(
  stores: Stores,
  resourceUrl: string,
  payTo: string,
  network: StellarNetwork = "stellar:testnet",
) {
  await stores.catalog.upsert({
    keyVersion: CATALOG_KEY_VERSION,
    ledger: 1,
    checkedAt: 1,
    key: { network, payTo, method: "GET", resourceUrl },
    resource: {
      resource: resourceUrl,
      type: "http",
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network,
          asset: "CASSET",
          amount: "10000",
          payTo,
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
      lastUpdated: "2026-11-27T00:00:00.000Z",
      description: "Hourly weather forecast for a city",
      extensions: { bazaar: { info: { input: { type: "http" } } } },
    },
  });
}

/**
 * One listing curated, and its neighbours that are not: another host with no record, a host whose
 * check found no proof, the curated host with another payTo, and the curated host on the other
 * network.
 */
async function seed(stores: Stores, pool: Parameters<typeof createPostgresCurationStore>[0]) {
  await listing(stores, "https://pogoda.pl/forecast", PAY_A);
  await listing(stores, "https://kursy.example.com/forecast", PAY_A);
  await listing(stores, "https://wiatr.example.com/forecast", PAY_A);
  await listing(stores, "https://pogoda.pl/forecast-b", PAY_B);
  await listing(stores, "https://pogoda.pl/forecast-pubnet", PAY_A, "stellar:pubnet");
  const curation = createPostgresCurationStore(pool);
  await curation.put({
    network: "stellar:testnet",
    host: "pogoda.pl",
    payTo: PAY_A,
    curated: true,
    checkedAt: CHECKED_AT,
  });
  await curation.put({
    network: "stellar:testnet",
    host: "wiatr.example.com",
    payTo: PAY_A,
    curated: false,
    checkedAt: CHECKED_AT,
  });
}

/** Each item's `curated`, by its resource URL. */
const curatedOf = (items: DiscoveryResource[]) =>
  Object.fromEntries(
    items.map((item) => [
      item.resource,
      (item as DiscoveryResource & { curated?: unknown }).curated,
    ]),
  );

const EXPECTED = {
  "https://pogoda.pl/forecast": true,
  "https://kursy.example.com/forecast": false,
  "https://wiatr.example.com/forecast": false,
  "https://pogoda.pl/forecast-b": false,
  "https://pogoda.pl/forecast-pubnet": false,
};

describe("CatalogStore: curated", () => {
  const db = testDatabase();
  let stores: Stores;
  beforeEach(async () => {
    await db.empty();
    stores = db.stores();
    await seed(stores, db.pool);
  });

  it("follows a record that changes", async () => {
    await createPostgresCurationStore(db.pool).put({
      network: "stellar:testnet",
      host: "pogoda.pl",
      payTo: PAY_A,
      curated: false,
      checkedAt: null,
    });
    const { items } = await stores.catalog.list({ limit: 10, offset: 0 }, Date.now());
    expect(curatedOf(items)["https://pogoda.pl/forecast"]).toBe(false);
  });
});

describe("GET /discovery/resources and /discovery/search: curated", () => {
  const db = testDatabase();
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const env = {
      ...signerEnv(Keypair.random().publicKey()),
      DATABASE_URL: db.urlFor(db.schema),
      CHANNELS: Keypair.random().publicKey(),
      CLIENT_IP: "socket",
      SEARCH_MODEL_URL: "http://127.0.0.1:9",
      RATE_LIMIT_DISCOVERY: "1000000",
    };
    const config = { ...parseConfig(env), port: 0 };
    const stores = db.stores();
    await seed(stores, db.pool);
    app = await start({
      config,
      embedder: noSearchModel,
      logger: jsonLogger("debug", () => {}),
      metrics: memoryMetrics(),
      stores,
      verify: vi.fn<Verify>(),
      settle: vi.fn<Settle>(),
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.random().publicKey()),
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  it("carries curated on every item of /discovery/resources, beside lastUpdated", async () => {
    const response = await fetch(`${url}/discovery/resources?limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as DiscoveryResourcesResponse;
    expect(curatedOf(body.items)).toEqual(EXPECTED);
    expect(body.items[0]).toMatchObject({ lastUpdated: "2026-11-27T00:00:00.000Z" });
  });

  it("carries curated on every item of /discovery/search", async () => {
    const response = await fetch(`${url}/discovery/search?query=weather&limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SearchDiscoveryResourcesResponse;
    expect(curatedOf(body.resources)).toEqual(EXPECTED);
  });
});
