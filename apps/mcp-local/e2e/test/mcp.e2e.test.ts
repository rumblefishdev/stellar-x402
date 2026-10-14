// stellar-x402-mcp end to end (task 0037): the built CLI over MCP stdio, as Claude Desktop runs it.
// Scenarios E-01…E-23 were written from the README, the tool list and the acceptance criteria only,
// by a reviewer who had not read the code. Two real testnet payments of 0.001 USDC (E-21, E-22) go
// to the example seller and settle through the public x402.org facilitator; every other paid path
// uses a local fake seller that signs nothing it forwards, so no money moves.
//
// Run from the repo root: pnpm e2e:testnet. Results go to results/testnet-results.json.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequired } from "@x402/core/types";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  CATALOG,
  startFakeCatalog,
  type FakeCatalog,
} from "../../../../packages/mcp/test/fake-catalog.js";
import { type Answer, captured, code, failedStart, startServer } from "../src/cli.js";
import {
  answer402,
  FAKE_HASH,
  type FakeSeller,
  settlement,
  startFakeSeller,
  withOffer,
} from "../src/fakes.js";
import { friendbot, succeeded, usdcBalance } from "../src/horizon.js";
import { type Keys, readKeys } from "../src/keys.js";
import { row, writeResults } from "../src/results.js";
import { type ExampleSeller, startExampleSeller } from "../src/seller.js";

let keys: Keys;
let unfunded: Keypair;
let catalog: FakeCatalog;
let example: ExampleSeller;
/** The example seller's 402, read in E-07; the fake sellers answer copies of it. */
let terms: PaymentRequired;
const scratch = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
let dirs = 0;

/** A fresh, empty state directory, so each scenario's daily budget starts at zero. */
function freshDir(): string {
  return join(scratch, `state-${++dirs}`);
}

function base(extra: Record<string, string> = {}): Record<string, string> {
  return {
    STELLAR_X402_DISCOVERY_URL: catalog.url,
    STELLAR_X402_ALLOW_INSECURE_LOCAL: "1",
    STELLAR_X402_TIMEOUT_MS: "3000",
    ...extra,
  };
}

function paying(extra: Record<string, string> = {}): Record<string, string> {
  return base({
    STELLAR_X402_SECRET_KEY: keys.buyerSecret,
    STELLAR_X402_MAX_PER_CALL: "10000",
    STELLAR_X402_DAILY_BUDGET: "1000000",
    STELLAR_X402_STATE_DIR: freshDir(),
    ...extra,
  });
}

const weather = () => `${example.url}/weather?city=Warsaw`;
const get = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  method: "GET",
  ...extra,
});

/** Waits for Horizon to show a balance other than `before`, up to 30 s; the last read otherwise. */
async function balanceAfter(account: string, before: bigint): Promise<bigint> {
  let now = before;
  for (let i = 0; i < 30 && now === before; i++) {
    await new Promise((done) => setTimeout(done, 1_000));
    now = await usdcBalance(account);
  }
  return now;
}

beforeAll(async () => {
  keys = readKeys();
  unfunded = Keypair.random();
  await friendbot(unfunded.publicKey());
  catalog = await startFakeCatalog();
  example = await startExampleSeller(keys.sellerPublic);
});

afterAll(async () => {
  example?.stop();
  await catalog?.close();
  rmSync(scratch, { recursive: true, force: true });
  writeResults();
});

describe("start-up", () => {
  it("E-01 refuses wrong settings and names the variable", async () => {
    const key = keys.buyerSecret;
    const cases: [string, Record<string, string>, string][] = [
      ["b", base({ STELLAR_X402_DISCOVERY_URL: "" }), "STELLAR_X402_DISCOVERY_URL"],
      ["c", base({ STELLAR_X402_SECRET_KEY: key }), "STELLAR_X402_MAX_PER_CALL"],
      [
        "d",
        base({ STELLAR_X402_SECRET_KEY: key, STELLAR_X402_MAX_PER_CALL: "10000" }),
        "STELLAR_X402_DAILY_BUDGET",
      ],
      ["e", base({ STELLAR_X402_DAILY_BUDGET: "100" }), "STELLAR_X402_DAILY_BUDGET"],
      ["f", paying({ STELLAR_X402_NETWORK: "stellar:pubnet" }), "STELLAR_X402_NETWORK"],
      ["g", paying({ STELLAR_X402_MAX_PER_CALL: "1e3" }), "STELLAR_X402_MAX_PER_CALL"],
      ["h", base({ STELLAR_X402_TIMEOUT_MS: "0" }), "STELLAR_X402_TIMEOUT_MS"],
      ["i", base({ STELLAR_X402_MAX_PERCALL: "10" }), "STELLAR_X402_MAX_PERCALL"],
      ["j", paying({ STELLAR_X402_BUDGET: "100" }), "STELLAR_X402_BUDGET"],
      ["k", paying({ STELLAR_X402_STATE_FILE: "/tmp/x" }), "STELLAR_X402_STATE_FILE"],
      [
        "l",
        paying({ STELLAR_X402_SECRET_KEY: "SNOTAVALIDKEY0123456789" }),
        "STELLAR_X402_SECRET_KEY",
      ],
      ["m", paying({ STELLAR_X402_STATE_DIR: "relative/dir" }), "STELLAR_X402_STATE_DIR"],
    ];
    const noCatalog = base();
    delete noCatalog.STELLAR_X402_DISCOVERY_URL;
    cases.unshift(["a", noCatalog, "STELLAR_X402_DISCOVERY_URL"]);
    for (const [id, env, name] of cases) {
      const { code: exit, stderr } = await failedStart(env);
      row(
        `E-01${id}`,
        `exits non-zero naming ${name}`,
        [true, true],
        [exit !== 0 && exit !== null, stderr.includes(name)],
      );
    }
  });

  it("E-02 offers two tools without a key", async () => {
    const server = await startServer(base());
    const names = (await server.tools()).map((t) => t.name).sort();
    row("E-02", "tools", ["get_resource", "list_resources"], names);
    const answer = await server.call("call_paid_http", get("https://example.com/"));
    row(
      "E-02",
      "call_paid_http is an SDK error, not our shape",
      [true, undefined],
      [answer.isError, answer.value?.error],
    );
    await server.close();
  });

  it("E-03 offers three tools with a key and logs only the public address", async () => {
    const server = await startServer(paying());
    const tools = await server.tools();
    row(
      "E-03",
      "tools",
      ["call_paid_http", "get_resource", "list_resources"],
      tools.map((t) => t.name).sort(),
    );
    row(
      "E-03",
      "call_paid_http is destructive",
      true,
      tools.find((t) => t.name === "call_paid_http")?.annotations?.destructiveHint,
    );
    await server.close();
    row(
      "E-03",
      "stderr names the buyer's public address",
      true,
      server.stderr().includes(keys.buyerPublic),
    );
  });
});

describe("catalog", () => {
  it("E-04 lists with filters and paging, one catalog request per call", async () => {
    const server = await startServer(base());
    const has = (filter: (item: (typeof CATALOG)[number]) => boolean) =>
      CATALOG.filter(filter).length;
    const cases: [Record<string, unknown>, number, number][] = [
      [{}, CATALOG.length, CATALOG.length],
      [{ type: "http" }, has((i) => i.type === "http"), has((i) => i.type === "http")],
      [{ type: "mcp", payTo: "GSELLERB" }, 2, 2],
      [{ network: "stellar:pubnet" }, 1, 1],
      [
        { extensions: "bazaar" },
        has((i) => i.extensions?.bazaar !== undefined),
        has((i) => i.extensions?.bazaar !== undefined),
      ],
      [{ limit: 2, offset: 0 }, 2, CATALOG.length],
      [{ limit: 2, offset: 4 }, 1, CATALOG.length],
      [{ type: "http", network: "stellar:testnet", payTo: "GSELLERB" }, 0, 0],
    ];
    const before = catalog.queries.length;
    for (const [args, items, total] of cases) {
      const answer = await server.call("list_resources", args);
      const page = answer.value as { items: unknown[]; pagination: { total: number } };
      row(
        "E-04",
        `${JSON.stringify(args)} items and total`,
        [items, total],
        [page.items.length, page.pagination.total],
      );
    }
    row("E-04", "catalog requests", cases.length, catalog.queries.length - before);
    await server.close();
  });

  it("E-05 a catalog failure is upstream_error and the server keeps running", async () => {
    const down = await startFakeCatalog();
    await down.close();
    const failing = await startFakeCatalog();
    failing.failWith = 500;
    const malformed = await startFakeCatalog();
    malformed.malformed = true;
    const hanging = await startFakeCatalog();
    hanging.hang = true;
    for (const [id, fake] of [
      ["a", down],
      ["b", failing],
      ["c", malformed],
      ["d", hanging],
    ] as const) {
      const server = await startServer(
        base({ STELLAR_X402_DISCOVERY_URL: fake.url, STELLAR_X402_TIMEOUT_MS: "1000" }),
      );
      const started = Date.now();
      const first = code(await server.call("list_resources", {}));
      const seconds = (Date.now() - started) / 1000;
      const second = code(await server.call("list_resources", {}));
      row(
        `E-05${id}`,
        "code, twice, within 2 s",
        ["upstream_error", "upstream_error", true],
        [first, second, seconds < 2],
      );
      await server.close();
    }
    await Promise.all([failing.close(), malformed.close(), hanging.close()]);
  });

  it("E-06 input failing a schema is the SDK's error", async () => {
    const server = await startServer(paying());
    const cases: [string, Record<string, unknown>][] = [
      ["list_resources", { limit: -1 }],
      ["get_resource", { method: "GET" }],
      ["call_paid_http", { url: "https://example.com/", method: "HEAD" }],
      ["list_resources", { foo: 1 }],
    ];
    for (const [tool, args] of cases) {
      const answer = await server.call(tool, args);
      row(
        "E-06",
        `${tool} ${JSON.stringify(args)}`,
        [true, true],
        [answer.isError, answer.text.includes("-32602")],
      );
    }
    await server.close();
  });
});

describe("get_resource", () => {
  it("E-07 reads the example seller's terms and spends nothing", async () => {
    const before = await usdcBalance(keys.buyerPublic);
    const server = await startServer(base());
    const answer = await server.call("get_resource", get(weather()));
    await server.close();
    const value = answer.value as { status: number; paymentRequired: PaymentRequired };
    terms = value.paymentRequired;
    const offer = terms.accepts[0]!;
    row(
      "E-07",
      "402 at 10000 on testnet, valid ≤ 300 s",
      [402, "10000", "stellar:testnet", true],
      [value.status, offer.amount, offer.network, offer.maxTimeoutSeconds <= 300],
    );
    row(
      "E-07",
      "buyer balance unchanged",
      String(before),
      String(await usdcBalance(keys.buyerPublic)),
    );
  });

  it("E-08 answers each seller failure with its code", async () => {
    let nested: unknown = { type: "string" };
    for (let i = 0; i < 50; i++) nested = { type: "object", properties: { a: nested } };
    const fake = await startFakeSeller(terms, {
      "/free": {
        unpaid: (res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"),
      },
      "/nohdr": { unpaid: (res) => res.writeHead(402).end("{}") },
      "/deep": {
        unpaid: (res, t) =>
          answer402({
            ...t,
            extensions: { bazaar: { ...(t.extensions?.bazaar as object), schema: nested } },
          })(res),
      },
      "/boom": { unpaid: (res) => res.writeHead(500).end() },
      "/big": { unpaid: (res) => res.writeHead(200).end("x".repeat(5_000)) },
      "/gzip": {
        unpaid: (res) =>
          res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(1_000_000))),
      },
      "/stall": { unpaid: (res) => res.writeHead(200).write("part") },
      "/redir": { unpaid: (res) => res.writeHead(302, { location: `${fake.url}/free` }).end() },
      "/pubnet402": {
        unpaid: (res, t) => answer402(withOffer(t, { network: "stellar:pubnet" }))(res),
      },
    });
    const server = await startServer(base({ STELLAR_X402_MAX_RESPONSE_BYTES: "1000" }));
    const cases: [string, string, string][] = [
      ["a", "/free", "ok"],
      ["b", "/nohdr", "unsupported_payment"],
      ["c", "/deep", "unsupported_payment"],
      ["d", "/gone", "resource_not_found"],
      ["e", "/boom", "upstream_error"],
      ["f", "/big", "response_too_large"],
      ["g", "/gzip", "response_too_large"],
      ["h", "/stall", "upstream_error"],
      ["i", "/redir", "unsafe_url"],
      ["j", "/pubnet402", "ok"],
    ];
    for (const [id, path, expected] of cases) {
      const answer = await server.call("get_resource", get(`${fake.url}${path}`));
      row(`E-08${id}`, `get_resource ${path}`, expected, code(answer));
      if (id === "j") {
        const value = answer.value as { status: number; paymentRequired: PaymentRequired };
        row(
          "E-08j",
          "terms returned as given",
          [402, "stellar:pubnet"],
          [value.status, value.paymentRequired.accepts[0]!.network],
        );
      }
    }
    row(
      "E-08i",
      "redirect not followed",
      1,
      fake.requests.filter((r) => r.path === "/free").length,
    );
    await server.close();
    await fake.close();
  });

  it("E-09 refuses addresses that are not public, before any request", async () => {
    const fake = await startFakeSeller(terms, {
      "/free": { unpaid: (res) => res.writeHead(200).end("{}") },
    });
    const env = paying();
    const server = await startServer(env);
    const refused: [string, string, string][] = [
      ["a", "get_resource", "not a url"],
      ["b", "get_resource", "http://example.com/"],
      ["c", "get_resource", "https://10.0.0.1/x"],
      ["d", "get_resource", "http://192.168.1.1/x"],
      ["e", "call_paid_http", "https://169.254.169.254/latest"],
    ];
    for (const [id, tool, url] of refused)
      row(`E-09${id}`, `${tool} ${url}`, "unsafe_url", code(await server.call(tool, get(url))));
    const local = fake.url.replace("127.0.0.1", "localhost");
    row(
      "E-09",
      "control: localhost and 127.0.0.1 pass with the switch",
      ["ok", "ok"],
      [
        code(await server.call("get_resource", get(`${local}/free`))),
        code(await server.call("get_resource", get(`${fake.url}/free`))),
      ],
    );
    await server.close();
    const strict = { ...env };
    delete strict.STELLAR_X402_ALLOW_INSECURE_LOCAL;
    const strictServer = await startServer(strict);
    row(
      "E-09f",
      "127.0.0.1 without the switch",
      "unsafe_url",
      code(await strictServer.call("get_resource", get(`${fake.url}/free`))),
    );
    await strictServer.close();
    row(
      "E-09",
      "nothing counted",
      false,
      existsSync(join(env.STELLAR_X402_STATE_DIR!, "spent.sqlite")),
    );
    row("E-09", "requests reaching the seller", 2, fake.requests.length);
    await fake.close();
  });
});

describe("call_paid_http refusals before signing", () => {
  let fake: FakeSeller;
  beforeAll(async () => {
    const other = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const with402 = (change: (copy: PaymentRequired) => PaymentRequired) => ({
      unpaid: (res: ServerResponse, copy: PaymentRequired) => answer402(change(copy))(res),
    });
    const accepts =
      (...offers: Partial<PaymentRequired["accepts"][number]>[]) =>
      (t: PaymentRequired) => ({
        ...t,
        accepts: offers.map((change) => ({ ...t.accepts[0]!, ...change })),
      });
    fake = await startFakeSeller(terms, {
      "/paid": {},
      "/othasset": with402(accepts({ asset: other })),
      "/pubnet": with402(accepts({ network: "stellar:pubnet" })),
      "/long": with402(accepts({ maxTimeoutSeconds: 600 })),
      "/negative": with402(accepts({ amount: "-5" })),
      "/zero": with402(accepts({ amount: "0" })),
      "/upto": with402(accepts({ scheme: "upto" })),
      "/long-pricey": with402(accepts({ maxTimeoutSeconds: 600, amount: "20000" })),
      "/other-then-long": with402(accepts({ asset: other }, { maxTimeoutSeconds: 600 })),
      "/pricey": with402(accepts({ amount: "20000" })),
    });
  });
  afterAll(() => fake.close());

  it("E-10 to E-13 refuse with the first check that leaves no offer, and sign nothing", async () => {
    const server = await startServer(paying());
    const cases: [string, string, string, Record<string, unknown>?][] = [
      ["E-10", "/paid", "invalid_input", { body: "{}" }],
      ["E-11", "/othasset", "asset_not_allowed"],
      ["E-12a", "/pubnet", "unsupported_payment"],
      ["E-12b", "/long", "unsupported_payment"],
      ["E-12c", "/negative", "unsupported_payment"],
      ["E-12d", "/zero", "unsupported_payment"],
      ["E-12e", "/upto", "unsupported_payment"],
      ["E-12f", "/long-pricey", "unsupported_payment"],
      ["E-12g", "/other-then-long", "unsupported_payment"],
      ["E-13a", "/pricey", "over_price_limit"],
    ];
    for (const [id, path, expected, extra] of cases)
      row(
        id,
        `call_paid_http ${path}`,
        expected,
        code(await server.call("call_paid_http", get(`${fake.url}${path}`, extra))),
      );
    const getWithBody = await server.call("get_resource", get(`${fake.url}/paid`, { body: "{}" }));
    row(
      "E-10",
      "get_resource GET with a body (recorded, F-10)",
      "invalid_input",
      code(getWithBody),
    );
    row(
      "E-10…13",
      "signed payments the seller received",
      0,
      fake.requests.filter((r) => r.paid).length,
    );
    await server.close();
  });
});

describe("call_paid_http after signing (fake seller, no money moves)", () => {
  it("E-13b pays the offer within the limit when the seller lists two", async () => {
    const fake = await startFakeSeller(terms, {
      "/two": {
        unpaid: (res, t) =>
          answer402({
            ...t,
            accepts: [
              { ...t.accepts[0]!, amount: "20000" },
              { ...t.accepts[0]!, amount: "5000" },
            ],
          })(res),
        paid: (res) =>
          res.writeHead(200, { "payment-response": settlement(true, FAKE_HASH) }).end("{}"),
      },
    });
    const server = await startServer(paying());
    const answer = await server.call("call_paid_http", get(`${fake.url}/two`));
    const payment = (answer.value as { payment?: { amount: string; transaction: string | null } })
      .payment;
    row(
      "E-13b",
      "paid amount and the settlement's hash (F-11)",
      ["ok", "5000", FAKE_HASH],
      [code(answer), payment?.amount, payment?.transaction],
    );
    await server.close();
    await fake.close();
  });

  it("E-14 an unfunded payer is insufficient_funds, twice", async () => {
    const server = await startServer(
      paying({
        STELLAR_X402_SECRET_KEY: unfunded.secret(),
        STELLAR_X402_DAILY_BUDGET: "10000",
        STELLAR_X402_TIMEOUT_MS: "30000",
      }),
    );
    const first = code(await server.call("call_paid_http", get(weather())));
    const second = code(await server.call("call_paid_http", get(weather())));
    row("E-14", "both calls", ["insufficient_funds", "insufficient_funds"], [first, second]);
    await server.close();
  });

  it("E-15 a refused payment is payment_rejected and stays counted", async () => {
    const fake = await startFakeSeller(terms, {
      "/rej-settle": {
        paid: (res) => res.writeHead(200, { "payment-response": settlement(false, "") }).end("{}"),
      },
      "/rej-402": { paid: (res) => answer402(terms)(res) },
      "/ok": {},
    });
    const server = await startServer(paying({ STELLAR_X402_DAILY_BUDGET: "20000" }));
    const results = [];
    for (const path of ["/rej-settle", "/rej-402", "/ok"])
      results.push(code(await server.call("call_paid_http", get(`${fake.url}${path}`))));
    row(
      "E-15",
      "rejected, rejected, then over the budget",
      ["payment_rejected", "payment_rejected", "over_budget"],
      results,
    );
    row("E-15", "signed payments received", 2, fake.requests.filter((r) => r.paid).length);
    await server.close();
    await fake.close();
  });

  it("E-16 anything else after the payment left is payment_unknown, within one deadline", async () => {
    const fake = await startFakeSeller(terms, {
      "/stall": { paid: (res) => res.writeHead(200).write("part") },
      "/redir": { paid: (res) => res.writeHead(302, { location: `${fake.url}/free` }).end() },
      "/boom": { paid: (res) => res.writeHead(500).end() },
      "/big": { paid: (res) => res.writeHead(200).end("x".repeat(5_000)) },
      "/drop": { paid: (res) => res.socket?.destroy() },
      "/slow": {
        // Signing takes about a second (it simulates on testnet), so the payment leaves before the
        // deadline and its answer comes after it.
        unpaid: (res, t) => setTimeout(() => answer402(t)(res), 500),
        paid: (res) => setTimeout(() => res.writeHead(200).end("{}"), 3_000),
      },
      "/free": { unpaid: (res) => res.writeHead(200).end("{}") },
    });
    const env = paying({ STELLAR_X402_MAX_RESPONSE_BYTES: "1000" });
    const server = await startServer(env);
    for (const [id, path] of [
      ["a", "/stall"],
      ["b", "/redir"],
      ["c", "/boom"],
      ["d", "/big"],
      ["e", "/drop"],
      ["f", "/slow"],
    ]) {
      const started = Date.now();
      const answer = await server.call("call_paid_http", get(`${fake.url}${path}`));
      const seconds = (Date.now() - started) / 1000;
      row(
        `E-16${id}`,
        `call_paid_http ${path}, within 4 s`,
        ["payment_unknown", true],
        [code(answer), seconds < 4],
      );
    }
    row(
      "E-16b",
      "redirect not followed",
      0,
      fake.requests.filter((r) => r.path === "/free").length,
    );
    row(
      "E-16",
      "amounts counted",
      true,
      existsSync(join(env.STELLAR_X402_STATE_DIR!, "spent.sqlite")),
    );
    await server.close();
    await fake.close();
  });

  it("E-17 a successful call can carry no hash, and a 500 with a settlement is a result", async () => {
    const fake = await startFakeSeller(terms, {
      "/no-header": {
        paid: (res) =>
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'),
      },
      "/not-a-hash": {
        paid: (res) =>
          res.writeHead(200, { "payment-response": settlement(true, "not-a-hash") }).end("{}"),
      },
      "/500-settled": {
        paid: (res) =>
          res.writeHead(500, { "payment-response": settlement(true, FAKE_HASH) }).end("{}"),
      },
      "/text": { paid: (res) => res.writeHead(200, { "content-type": "text/plain" }).end("hello") },
    });
    const server = await startServer(paying());
    const result = async (path: string) =>
      (await server.call("call_paid_http", get(`${fake.url}${path}`))).value as {
        status: number;
        contentType: string;
        body: string;
        payment: { transaction: string | null; amount: string };
      };
    const a = await result("/no-header");
    row(
      "E-17a",
      "no settlement header",
      [200, null, "10000", '{"ok":true}'],
      [a.status, a.payment.transaction, a.payment.amount, a.body],
    );
    row("E-17b", "a hash that is not one", null, (await result("/not-a-hash")).payment.transaction);
    const c = await result("/500-settled");
    row("E-17c", "500 with a settlement", [500, FAKE_HASH], [c.status, c.payment.transaction]);
    row("E-17d", "content type (recorded)", "text/plain", (await result("/text")).contentType);
    await server.close();
    await fake.close();
  });

  it("E-18 a database held by another process is payment_failed, then pays", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const env = paying({ STELLAR_X402_TIMEOUT_MS: "10000" });
    const server = await startServer(env);
    row(
      "E-18",
      "first payment creates the database",
      "ok",
      code(await server.call("call_paid_http", get(`${fake.url}/ok`))),
    );
    const holder = new DatabaseSync(join(env.STELLAR_X402_STATE_DIR!, "spent.sqlite"));
    holder.exec("BEGIN EXCLUSIVE");
    const release = setTimeout(() => holder.exec("ROLLBACK"), 8_000);
    const started = Date.now();
    const locked = code(await server.call("call_paid_http", get(`${fake.url}/ok`)));
    const seconds = (Date.now() - started) / 1000;
    await new Promise((done) => setTimeout(done, 8_500 - (Date.now() - started)));
    clearTimeout(release);
    holder.close();
    row(
      "E-18",
      "locked: payment_failed after ~5 s, log names the lock",
      ["payment_failed", true, true],
      [locked, seconds >= 4.5 && seconds < 8, server.stderr().includes("database is locked")],
    );
    row(
      "E-18",
      "after the lock is gone",
      "ok",
      code(await server.call("call_paid_http", get(`${fake.url}/ok`))),
    );
    row("E-18", "signed payments received", 2, fake.requests.filter((r) => r.paid).length);
    await server.close();
    await fake.close();
  });

  it("E-19 the daily budget is shared, survives a restart and resets when the file is deleted", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const dir = freshDir();
    const env = (daily: string) =>
      paying({ STELLAR_X402_STATE_DIR: dir, STELLAR_X402_DAILY_BUDGET: daily });
    const pay = async (server: Awaited<ReturnType<typeof startServer>>) =>
      code(await server.call("call_paid_http", get(`${fake.url}/ok`)));
    const [a, b] = await Promise.all([startServer(env("25000")), startServer(env("25000"))]);
    const seen = [await pay(a), await pay(a), await pay(b)];
    await Promise.all([a.close(), b.close()]);
    const c = await startServer(env("25000"));
    seen.push(await pay(c));
    await c.close();
    const d = await startServer(env("1000000"));
    seen.push(await pay(d));
    await d.close();
    rmSync(join(dir, "spent.sqlite"));
    const e = await startServer(env("25000"));
    seen.push(await pay(e), await pay(e));
    await e.close();
    row(
      "E-19",
      "A, A, B, restart C, D with a larger budget, reset E, E",
      ["ok", "ok", "over_budget", "over_budget", "ok", "ok", "ok"],
      seen,
    );
    await fake.close();
  });

  it("E-20 two processes paying at the same moment pass the day once (5 rounds, a sample)", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    for (let round = 1; round <= 5; round++) {
      const env = paying({ STELLAR_X402_DAILY_BUDGET: "10000" });
      const [p, q] = await Promise.all([startServer(env), startServer(env)]);
      const paidBefore = fake.requests.filter((r) => r.paid).length;
      const codes = (
        await Promise.all([p, q].map((s) => s.call("call_paid_http", get(`${fake.url}/ok`))))
      )
        .map(code)
        .sort();
      row(
        `E-20.${round}`,
        "one paid, one over the budget; one payment sent",
        [["ok", "over_budget"], 1],
        [codes, fake.requests.filter((r) => r.paid).length - paidBefore],
      );
      await Promise.all([p.close(), q.close()]);
    }
    await fake.close();
  });
});

describe("real payments on testnet (0.002 USDC)", () => {
  /** Pays the example seller once and checks it on Horizon: the buyer −10000, the seller +10000. */
  async function payAndCheck(id: string, env: Record<string, string>): Promise<void> {
    const buyerBefore = await usdcBalance(keys.buyerPublic);
    const sellerBefore = await usdcBalance(keys.sellerPublic);
    const server = await startServer(env);
    const answer: Answer = await server.call("call_paid_http", get(weather()));
    await server.close();
    const value = answer.value as {
      status: number;
      body: string;
      payment: { network: string; amount: string; asset: string; transaction: string | null };
    };
    const hash = value.payment?.transaction ?? undefined;
    row(
      id,
      "paid result",
      ["ok", 200, "stellar:testnet", "10000", terms.accepts[0]!.asset, true],
      [
        code(answer),
        value.status,
        value.payment?.network,
        value.payment?.amount,
        value.payment?.asset,
        /^[0-9a-f]{64}$/.test(hash ?? ""),
      ],
      hash,
    );
    row(id, "transaction successful on Horizon", true, hash ? await succeeded(hash) : false, hash);
    const buyerAfter = await balanceAfter(keys.buyerPublic, buyerBefore);
    const sellerAfter = await balanceAfter(keys.sellerPublic, sellerBefore);
    row(
      id,
      "buyer −10000, seller +10000",
      [-10000n, 10000n].map(String),
      [buyerAfter - buyerBefore, sellerAfter - sellerBefore].map(String),
      hash,
    );
  }

  it("E-21 pays the example seller", async () => {
    await payAndCheck("E-21", paying({ STELLAR_X402_TIMEOUT_MS: "30000" }));
  });

  it("E-22 pays once more, then the shared budget and the price limit refuse", async () => {
    const dir = freshDir();
    const env = paying({
      STELLAR_X402_TIMEOUT_MS: "30000",
      STELLAR_X402_STATE_DIR: dir,
      STELLAR_X402_DAILY_BUDGET: "10000",
    });
    await payAndCheck("E-22a", env);
    const before = await usdcBalance(keys.buyerPublic);
    const y = await startServer(env);
    row(
      "E-22b",
      "another process, same directory",
      "over_budget",
      code(await y.call("call_paid_http", get(weather()))),
    );
    await y.close();
    const z = await startServer(
      paying({ STELLAR_X402_TIMEOUT_MS: "30000", STELLAR_X402_MAX_PER_CALL: "9999" }),
    );
    row(
      "E-22c",
      "per-call limit under the price",
      "over_price_limit",
      code(await z.call("call_paid_http", get(weather()))),
    );
    await z.close();
    await new Promise((done) => setTimeout(done, 6_000));
    row(
      "E-22",
      "buyer balance unchanged by b and c",
      String(before),
      String(await usdcBalance(keys.buyerPublic)),
    );
  });
});

it("E-23 no secret appears in anything the servers wrote", () => {
  const all = captured.join("\n");
  const secrets = {
    buyer: keys.buyerSecret,
    "buyer without its S": keys.buyerSecret.slice(1),
    unfunded: unfunded.secret(),
    "malformed key of E-01l": "SNOTAVALIDKEY0123456789",
  };
  for (const [name, secret] of Object.entries(secrets))
    row("E-23", `no ${name} secret in ${captured.length} captures`, false, all.includes(secret));
});
