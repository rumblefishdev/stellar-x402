import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCataloger } from "../src/catalog/cataloger.js";
import {
  REQUEST_GAP_MS,
  fileResources,
  parseHosts,
  reportLines,
  seedHosts,
} from "../src/catalog/seed.js";
import { SELLER_USER_AGENT } from "../src/catalog/seller-check.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { testDatabase } from "./database.js";
import { startSeller, type Seller } from "./seller.js";

describe("the hosts file (0155 decision 13)", () => {
  it("reads one host a line, skipping blank lines and # comments", () => {
    const text = "a.example\n\n  # from the owner's list\n b.example \nhttp://127.0.0.1:8080\n";
    expect(parseHosts(text)).toEqual([
      "https://a.example",
      "https://b.example",
      "http://127.0.0.1:8080",
    ]);
  });

  it("asks a host once, however often the file names it", () => {
    expect(parseHosts("a.example\nhttps://a.example\na.example/\n")).toEqual(["https://a.example"]);
  });
});

describe("the seller's /.well-known/x402 (0155 decisions 9, 10)", () => {
  const origin = "https://seller.example";

  it("reads URLs as strings, as 'METHOD URL' and as objects, each once", () => {
    const file = {
      version: 1,
      resources: [
        "https://seller.example/a",
        "POST https://seller.example/b",
        { url: "https://seller.example/c", method: "post" },
        { resource: "https://seller.example/d" },
        { path: "/e" },
        "https://seller.example/a",
      ],
    };
    expect(fileResources(origin, file)).toEqual({
      ok: true,
      resources: [
        { url: "https://seller.example/a", method: "GET" },
        { url: "https://seller.example/b", method: "POST" },
        { url: "https://seller.example/c", method: "POST" },
        { url: "https://seller.example/d", method: "GET" },
        { url: "https://seller.example/e", method: "GET" },
      ],
      offHost: 0,
      otherMethod: 0,
      unreadable: 0,
    });
  });

  it("counts and skips URLs on another host and methods other than GET and POST", () => {
    const file = {
      resources: [
        "https://other.example/a",
        { url: "https://seller.example/b", method: "DELETE" },
        "https://seller.example/c",
      ],
    };
    expect(fileResources(origin, file)).toMatchObject({
      ok: true,
      resources: [{ url: "https://seller.example/c", method: "GET" }],
      offHost: 1,
      otherMethod: 1,
    });
  });

  it("counts every entry it can't read a URL from (decision 15)", () => {
    const file = { resources: [{ url: 5 }, "http://[bad", {}, "https://seller.example/ok"] };
    expect(fileResources(origin, file)).toMatchObject({
      ok: true,
      resources: [{ url: "https://seller.example/ok" }],
      unreadable: 3,
    });
  });

  it("refuses a file with no resource list", () => {
    expect(fileResources(origin, { resourcesCatalog: "https://x" })).toEqual({
      ok: false,
      reason: "no_resources",
    });
    expect(fileResources(origin, "text")).toEqual({ ok: false, reason: "no_resources" });
  });
});

const offer = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "10000",
  payTo: "GPAYTO",
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;

describe("seedHosts (0155)", () => {
  const db = testDatabase();
  let seller: Seller;
  beforeEach(async () => {
    await db.empty();
    seller = await startSeller((url) => ({
      x402Version: 2,
      resource: { url, description: "Weather" },
      accepts: [offer],
      extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
    }));
  });
  afterEach(() => {
    seller.server.close();
  });

  function setup() {
    const stores = db.stores();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cataloger = createCataloger({
      store: stores.catalog,
      attempts: stores.catalogAttempts,
      rateLimits: stores.rateLimits,
      metrics: memoryMetrics(),
      logger,
      listLocal: true,
    });
    const wait = vi.fn(async () => {});
    return { cataloger, wait, store: stores.catalog };
  }

  it("asks every URL of a host, a failing one never stopping the rest (decision 15)", async () => {
    seller.files["/.well-known/x402"] = JSON.stringify({
      resources: [`${seller.url}/a`, `${seller.url}/b`, "https://other.example/c"],
    });
    seller.reply = async (request) => ({ status: request.url === "/b" ? 404 : 402 });
    const { cataloger, wait, store } = setup();
    const [report] = await seedHosts([seller.url], cataloger, { listLocal: true, wait });
    expect(report).toMatchObject({ origin: seller.url, file: "ok", listed: 2, offHost: 1 });
    expect(report!.results).toMatchObject([
      { url: `${seller.url}/a`, outcome: "refreshed" },
      { url: `${seller.url}/b`, outcome: "not_askable", reason: "not_402" },
    ]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(1);
    // /a cost two requests (the one that learns its listing, then the check).
    expect(wait.mock.calls).toEqual([[2 * REQUEST_GAP_MS]]);
    expect(seller.userAgents[0]).toBe(SELLER_USER_AGENT);
  });

  it("reports a host whose file can't be read, and seeds the other hosts", async () => {
    seller.files["/.well-known/x402"] = JSON.stringify({ resources: [`${seller.url}/a`] });
    const { cataloger, wait } = setup();
    const reports = await seedHosts(["http://127.0.0.1:1", seller.url], cataloger, {
      listLocal: true,
      wait,
    });
    expect(reports[0]).toMatchObject({ origin: "http://127.0.0.1:1", results: [] });
    expect(reports[0]!.file).not.toBe("ok");
    expect(reports[1]).toMatchObject({ file: "ok", results: [{ outcome: "refreshed" }] });
  });

  it("reports a file that isn't JSON", async () => {
    seller.files["/.well-known/x402"] = "<html>";
    const { cataloger, wait } = setup();
    const [report] = await seedHosts([seller.url], cataloger, { listLocal: true, wait });
    expect(report).toMatchObject({ file: "not_json", results: [] });
  });
});

describe("the seed's report (0155 decision 12)", () => {
  it("names a payTo seen on two hosts even where no listing was written, cleaned", () => {
    const lines = reportLines(
      ["https://a.example", "https://b.example"].map((origin) => ({
        origin,
        file: "ok",
        listed: 1,
        offHost: 0,
        otherMethod: 0,
        unreadable: 0,
        results: [
          {
            url: `${origin}/1`,
            method: "GET",
            network: "stellar:pubnet",
            payTo: "G\u001bX",
            outcome: "rejected",
            reason: "invalid_offer",
          },
        ],
      })),
    );
    expect(lines.at(-1)).toBe("payTo G X on 2 hosts: https://a.example, https://b.example");
  });

  it("prints a seller's text with no control character, so it can't drive the terminal", () => {
    const [line] = reportLines([
      {
        origin: "https://a.example",
        file: "ok",
        listed: 1,
        offHost: 0,
        otherMethod: 0,
        unreadable: 0,
        results: [
          {
            url: "https://a.example/1",
            method: "GET",
            outcome: "not_askable",
            reason: "not_402",
            detail: "status 404\u001b[2J\u0007\tok\n",
          },
        ],
      },
    ]);
    expect(line).toBe("https://a.example/1\tGET\t\t\tnot_askable\tnot_402\tstatus 404 [2J  ok ");
  });

  it("prints a line per result, then totals and every payTo on more than one host", () => {
    const result = (url: string, payTo: string, outcome = "refreshed") => ({
      url,
      method: "GET",
      network: "stellar:pubnet",
      payTo,
      outcome,
    });
    const lines = reportLines([
      {
        origin: "https://a.example",
        file: "ok",
        listed: 2,
        offHost: 0,
        otherMethod: 0,
        unreadable: 0,
        results: [
          result("https://a.example/1", "GSHARED"),
          { url: "https://a.example/2", method: "GET", outcome: "not_askable", reason: "not_402" },
        ],
      },
      {
        origin: "https://b.example",
        file: "ok",
        listed: 1,
        offHost: 0,
        otherMethod: 0,
        unreadable: 0,
        results: [result("https://b.example/1", "GSHARED")],
      },
      {
        origin: "https://c.example",
        file: "status 404",
        listed: 0,
        offHost: 0,
        otherMethod: 0,
        unreadable: 0,
        results: [],
      },
    ]);
    expect(lines).toEqual([
      "https://a.example/1\tGET\tstellar:pubnet\tGSHARED\trefreshed\t\t",
      "https://a.example/2\tGET\t\t\tnot_askable\tnot_402\t",
      "https://b.example/1\tGET\tstellar:pubnet\tGSHARED\trefreshed\t\t",
      "host https://a.example: file ok, 2 listed, 0 on another host, 0 other methods, 0 unreadable, 1 written",
      "host https://b.example: file ok, 1 listed, 0 on another host, 0 other methods, 0 unreadable, 1 written",
      "host https://c.example: file status 404, 0 listed, 0 on another host, 0 other methods, 0 unreadable, 0 written",
      "total: 2 written, 2 hosts with a listing, 1 payTo",
      "payTo GSHARED on 2 hosts: https://a.example, https://b.example",
    ]);
  });
});
