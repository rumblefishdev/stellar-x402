import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { SeedError, seedMain } from "../src/main.js";
import type { Logger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { testDatabase } from "./database.js";
import { startSeller, type Seller } from "./seller.js";

describe("the hosts file (0155 decision 13)", () => {
  it("reads one host a line, skipping blank lines and # comments", () => {
    const text = "a.example\n\n  # from the owner's list\n b.example \nhttp://127.0.0.1:8080\n";
    expect(parseHosts(text)).toEqual({
      origins: ["https://a.example", "https://b.example", "http://127.0.0.1:8080"],
      invalid: [],
    });
  });

  it("asks a host once, however often the file names it", () => {
    expect(parseHosts("a.example\nhttps://a.example\na.example/\n").origins).toEqual([
      "https://a.example",
    ]);
  });

  it("refuses a hosts file with a line that isn't a host, before asking anyone", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "seed-")), "hosts.txt");
    await writeFile(path, "a.example\nhost:abc\n");
    await expect(seedMain([path], {})).rejects.toThrow(
      new SeedError("the hosts file has lines that aren't hosts: host:abc"),
    );
  });

  it("names every line that isn't a host, so a typo never vanishes", () => {
    expect(parseHosts("a.example\napi.seller .example\nhost:abc\n")).toEqual({
      origins: ["https://a.example"],
      invalid: ["api.seller .example", "host:abc"],
    });
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
      skipped: [],
    });
  });

  it("skips URLs on another host and methods other than GET and POST, naming each", () => {
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
      skipped: [
        { entry: "https://other.example/a", method: "GET", reason: "off_host" },
        { entry: "https://seller.example/b", method: "DELETE", reason: "other_method" },
      ],
    });
  });

  it("names every entry it can't read a URL from (decision 15)", () => {
    const file = { resources: [{ url: 5 }, "http://[bad", {}, "https://seller.example/ok"] };
    expect(fileResources(origin, file)).toMatchObject({
      ok: true,
      resources: [{ url: "https://seller.example/ok" }],
      skipped: [
        { entry: "an object", method: "GET", reason: "unreadable" },
        { entry: "http://[bad", method: "GET", reason: "unreadable" },
        { entry: "an object", method: "GET", reason: "unreadable" },
      ],
    });
  });

  it("names an entry nested too deep to print without failing on it", () => {
    const deep = JSON.parse(`[${"[".repeat(100_000)}${"]".repeat(100_000)}]`);
    expect(fileResources(origin, { resources: deep })).toMatchObject({
      ok: true,
      skipped: [{ entry: "an array", reason: "unreadable" }],
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
    expect(report).toMatchObject({ origin: seller.url, file: "ok", listed: 2 });
    expect(report!.skipped).toEqual([
      { entry: "https://other.example/c", method: "GET", reason: "off_host" },
    ]);
    expect(report!.results).toMatchObject([
      { url: `${seller.url}/a`, outcome: "refreshed" },
      { url: `${seller.url}/b`, outcome: "not_askable", reason: "not_402" },
    ]);
    expect((await store.list({ limit: 10, offset: 0 })).total).toBe(1);
    // /a cost one request: its 402 named the listing and was the check's answer.
    expect(wait.mock.calls).toEqual([[REQUEST_GAP_MS]]);
    expect(seller.userAgents[0]).toBe(SELLER_USER_AGENT);
  });

  it("skips a URL the host's robots.txt disallows, naming it (0155 decision 3, amended)", async () => {
    seller.files["/robots.txt"] = "User-agent: *\nDisallow: /private/\n";
    seller.files["/.well-known/x402"] = JSON.stringify({
      resources: [`${seller.url}/private/a`, `${seller.url}/b`],
    });
    const { cataloger, wait } = setup();
    const [report] = await seedHosts([seller.url], cataloger, { listLocal: true, wait });
    expect(report!.skipped).toEqual([
      { entry: `${seller.url}/private/a`, method: "GET", reason: "robots" },
    ]);
    expect(report!.results).toMatchObject([{ url: `${seller.url}/b`, outcome: "refreshed" }]);
    expect(seller.requests.map((request) => request.url)).not.toContain("/private/a");
  });

  it("follows the group that names our robot over the one for every robot", async () => {
    seller.files["/robots.txt"] =
      "User-agent: *\nDisallow: /\n\nUser-agent: stellar-x402-bazaar\nAllow: /\n";
    seller.files["/.well-known/x402"] = JSON.stringify({ resources: [`${seller.url}/a`] });
    const { cataloger, wait } = setup();
    const [report] = await seedHosts([seller.url], cataloger, { listLocal: true, wait });
    expect(report!.skipped).toEqual([]);
    expect(report!.results).toMatchObject([{ outcome: "refreshed" }]);
  });

  it("asks nothing of a host whose robots.txt answers a server error (RFC 9309 §2.3.1.4)", async () => {
    seller.reply = async (request) => ({ status: request.url === "/robots.txt" ? 503 : 402 });
    seller.files["/.well-known/x402"] = JSON.stringify({ resources: [`${seller.url}/a`] });
    const { cataloger, wait } = setup();
    const [report] = await seedHosts([seller.url], cataloger, { listLocal: true, wait });
    expect(report).toMatchObject({ file: "robots.txt status 503", results: [] });
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
        skipped: [],
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
        skipped: [],
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
    const result = (url: string, payTo: string, reason = "inserted") => ({
      url,
      method: "GET",
      network: "stellar:pubnet",
      payTo,
      outcome: "refreshed",
      reason,
    });
    const lines = reportLines([
      {
        origin: "https://a.example",
        file: "ok",
        listed: 2,
        skipped: [],
        results: [
          result("https://a.example/1", "GSHARED"),
          { url: "https://a.example/2", method: "GET", outcome: "not_askable", reason: "not_402" },
        ],
      },
      {
        origin: "https://b.example",
        file: "ok",
        listed: 1,
        skipped: [{ entry: "https://x.example/1", method: "GET", reason: "off_host" }],
        results: [result("https://b.example/1", "GSHARED", "updated")],
      },
      {
        origin: "https://c.example",
        file: "status 404",
        listed: 0,
        skipped: [],
        results: [],
      },
    ]);
    expect(lines).toEqual([
      "https://a.example/1\tGET\tstellar:pubnet\tGSHARED\trefreshed\tinserted\t",
      "https://a.example/2\tGET\t\t\tnot_askable\tnot_402\t",
      "https://b.example/1\tGET\tstellar:pubnet\tGSHARED\trefreshed\tupdated\t",
      "https://x.example/1\tGET\t\t\tskipped\toff_host\t",
      "host https://a.example: file ok, 2 listed, 0 on another host, 0 other methods, 0 unreadable, 0 refused by robots.txt, 1 written",
      "host https://b.example: file ok, 1 listed, 1 on another host, 0 other methods, 0 unreadable, 0 refused by robots.txt, 1 written",
      "host https://c.example: file status 404, 0 listed, 0 on another host, 0 other methods, 0 unreadable, 0 refused by robots.txt, 0 written",
      "total: 2 written (1 added, 1 updated), 2 hosts with a listing, 1 payTo",
      "payTo GSHARED on 2 hosts: https://a.example, https://b.example",
    ]);
  });
});
