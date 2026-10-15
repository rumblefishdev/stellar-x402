// stellar-x402-mcp end to end (task 0037): the built CLI over MCP stdio, as Claude Desktop runs it.
// Scenarios E-01…E-23 were written from the README, the tool list and the acceptance criteria only,
// by a reviewer who had not read the code. Two real testnet payments of 0.001 USDC (E-21, E-22) go
// to the example seller and settle through the public x402.org facilitator; every other paid path
// uses a local fake seller that never forwards what it receives, so no money moves.
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
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, describe, it } from "vitest";
import { startFakeCatalog, type FakeCatalog } from "../../../../packages/mcp/test/fake-catalog.js";
import {
  captured,
  code,
  failedStart,
  type PaidResult,
  running,
  started,
  startServer,
  type RunningServer,
} from "../src/cli.js";
import {
  answer402,
  FAKE_HASH,
  type FakeSeller,
  settlement,
  startFakeSeller,
  withOffers,
} from "../src/fakes.js";
import {
  friendbot,
  latestLedger,
  openUsdcTrustline,
  succeeded,
  usdcBalance,
  usdcTransfer,
  xlmBalance,
} from "../src/horizon.js";
import { type Keys, readKeys } from "../src/keys.js";
import { row, writeResults } from "../src/results.js";
import { type ExampleSeller, startExampleSeller } from "../src/seller.js";

/** The example seller's price: 0.001 testnet USDC. */
const PRICE = "10000";
/** Enough testnet USDC for two payments and a rerun; below it the run stops before any check. */
const MIN_BUYER_USDC = 100_000n;

let keys: Keys;
let unfunded: Keypair;
let catalog: FakeCatalog;
let example: ExampleSeller;
/** The example seller's 402; the fake sellers answer copies of it, so a real key signs them. */
let terms: PaymentRequired;
let setupError: unknown;
/** The secret of E-14b's account, searched for by E-23 too. */
let drained = "";
const scratch = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
let dirs = 0;

/** One catalog entry of the scenarios' catalog. */
function entry(
  resource: string,
  type: "http" | "mcp",
  network: string,
  payTo: string,
  bazaar: boolean,
): DiscoveryResource {
  return {
    resource,
    type,
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network,
        amount: PRICE,
        asset: "CUSDC",
        payTo,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    lastUpdated: "2026-10-14T00:00:00.000Z",
    description: `${resource} entry`,
    ...(bazaar && { extensions: { bazaar: { info: { input: { type, method: "GET" } } } } }),
  } as DiscoveryResource;
}
// Two payees and both networks, so each filter changes the answer.
const H1 = entry("https://h1.example.com/", "http", "stellar:testnet", "GPAYEE1", true);
const H2 = {
  ...entry("https://h2.example.com/", "http", "stellar:testnet", "GPAYEE2", false),
  description: "d".repeat(10_000),
};
const H3 = entry("https://h3.example.com/", "http", "stellar:pubnet", "GPAYEE1", false);
const M1 = entry("https://m1.example.com/mcp", "mcp", "stellar:testnet", "GPAYEE1", true);
const M2 = entry("https://m2.example.com/mcp", "mcp", "stellar:testnet", "GPAYEE2", false);
const CATALOG = [H1, H2, H3, M1, M2];

/** A fresh, empty state directory, so each scenario's daily budget starts at zero. */
function freshDir(): string {
  return join(scratch, `state-${++dirs}`);
}

/** Settings without a key; a 3 s time limit keeps the scenarios that wait short. */
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
    STELLAR_X402_MAX_PER_CALL: PRICE,
    STELLAR_X402_DAILY_BUDGET: "1000000",
    STELLAR_X402_STATE_DIR: freshDir(),
    ...extra,
  });
}

const weather = () => `${example.url}/weather?city=Warsaw`;
/** A seller tool's arguments for a GET of `url`. */
const httpArgs = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  method: "GET",
  ...extra,
});
const paidAt = (fake: FakeSeller, path?: string) =>
  fake.requests.filter((r) => r.paid && (path === undefined || r.path === path)).length;
const hitsOf = (fake: FakeSeller, path: string) =>
  fake.requests.filter((r) => r.path === path).length;

/** What a state directory's database has counted, in atomic units. */
function counted(dir: string): string {
  const db = new DatabaseSync(join(dir, "spent.sqlite"));
  try {
    const { total } = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM spent").get() as {
      total: number;
    };
    return String(total);
  } finally {
    db.close();
  }
}

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
  try {
    keys = readKeys();
    const balance = await usdcBalance(keys.buyerPublic);
    if (balance < MIN_BUYER_USDC)
      throw new Error(
        `the buyer holds ${balance} atomic USDC, under ${MIN_BUYER_USDC}: top it up from Circle's testnet faucet`,
      );
    unfunded = Keypair.random();
    await friendbot(unfunded.publicKey());
    catalog = await startFakeCatalog(CATALOG);
    example = await startExampleSeller(keys.sellerPublic);
    // The fake sellers copy these terms; without them no later scenario means anything.
    const server = await startServer(base());
    const answer = await server.call("get_resource", httpArgs(weather()));
    await server.close();
    terms = (answer.value as { paymentRequired: PaymentRequired }).paymentRequired;
    if (!terms?.accepts?.[0])
      throw new Error(`the example seller's terms cannot be read: ${answer.text}`);
  } catch (error) {
    setupError = error;
    throw error;
  }
});

afterAll(async () => {
  // A scenario that threw left its servers open.
  await Promise.all([...running].map((server) => server.close()));
  example?.stop();
  await catalog?.close();
  rmSync(scratch, { recursive: true, force: true });
  writeResults(setupError);
});

describe("start-up", () => {
  it("E-01 refuses wrong settings, exits on its own and names the variable", async () => {
    const key = keys.buyerSecret;
    const noCatalog = base();
    delete noCatalog.STELLAR_X402_DISCOVERY_URL;
    const cases: [string, Record<string, string>, string][] = [
      ["a", noCatalog, "STELLAR_X402_DISCOVERY_URL"],
      ["b", base({ STELLAR_X402_DISCOVERY_URL: "" }), "STELLAR_X402_DISCOVERY_URL"],
      ["c", base({ STELLAR_X402_SECRET_KEY: key }), "STELLAR_X402_MAX_PER_CALL"],
      [
        "d",
        base({ STELLAR_X402_SECRET_KEY: key, STELLAR_X402_MAX_PER_CALL: PRICE }),
        "STELLAR_X402_DAILY_BUDGET",
      ],
      ["f", paying({ STELLAR_X402_NETWORK: "stellar:pubnet" }), "STELLAR_X402_NETWORK"],
      ["g", paying({ STELLAR_X402_MAX_PER_CALL: "1e3" }), "STELLAR_X402_MAX_PER_CALL"],
      ["h", base({ STELLAR_X402_TIMEOUT_MS: "0" }), "STELLAR_X402_TIMEOUT_MS"],
      ["i", base({ STELLAR_X402_MAX_PERCALL: "10" }), "STELLAR_X402_MAX_PERCALL"],
      ["j", paying({ STELLAR_X402_BUDGET: "100" }), "STELLAR_X402_BUDGET is not a setting"],
      [
        "l",
        paying({ STELLAR_X402_SECRET_KEY: "SNOTAVALIDKEY0123456789" }),
        "STELLAR_X402_SECRET_KEY",
      ],
      ["m", paying({ STELLAR_X402_STATE_DIR: "relative/dir" }), "STELLAR_X402_STATE_DIR"],
    ];
    for (const [id, env, says] of cases) {
      const { code: exit, stderr } = await failedStart(env);
      // Exit code 1 (README); a server killed after 10 s would show null.
      row(`E-01${id}`, `exit 1, stderr says "${says}"`, [1, true], [exit, stderr.includes(says)]);
    }
  });

  it("E-02 offers two tools without a key, and call_paid_http is the SDK's error", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const server = await startServer(base());
    const tools = await server.tools();
    row(
      "E-02",
      "tools, each with an output schema",
      [["get_resource", "list_resources"], true],
      [tools.map((t) => t.name).sort(), tools.every((t) => t.outputSchema !== undefined)],
    );
    const answer = await server.call("call_paid_http", httpArgs(`${fake.url}/ok`));
    row(
      "E-02",
      "call_paid_http: -32602, not our shape, nothing sent",
      [true, true, undefined, 0],
      [answer.isError, answer.text.includes("-32602"), answer.value?.error, fake.requests.length],
    );
    await server.close();
    await fake.close();
  });

  it("E-03 offers three tools with a key and logs only the public address", async () => {
    const server = await startServer(paying());
    const tools = await server.tools();
    row(
      "E-03",
      "tools, each with an output schema",
      [["call_paid_http", "get_resource", "list_resources"], true],
      [tools.map((t) => t.name).sort(), tools.every((t) => t.outputSchema !== undefined)],
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
  it("E-04 lists with filters and paging, passing each filter on, one request per call", async () => {
    const server = await startServer(base());
    const resources = (items: DiscoveryResource[]) => items.map((i) => i.resource);
    const cases: [Record<string, unknown>, DiscoveryResource[], number][] = [
      [{}, CATALOG, 5],
      [{ type: "http" }, [H1, H2, H3], 3],
      [{ type: "mcp", payTo: "GPAYEE1" }, [M1], 1],
      [{ network: "stellar:pubnet" }, [H3], 1],
      [{ extensions: "bazaar" }, [H1, M1], 2],
      [{ limit: 2, offset: 0 }, [H1, H2], 5],
      [{ limit: 2, offset: 4 }, [M2], 5],
      [{ type: "http", network: "stellar:testnet", payTo: "GPAYEE2" }, [H2], 1],
    ];
    for (const [args, items, total] of cases) {
      const before = catalog.queries.length;
      const page = (await server.call("list_resources", args)).value as {
        items: { resource: string }[];
        pagination: { total: number };
      };
      const query = catalog.queries.at(-1)!;
      row(
        "E-04",
        `${JSON.stringify(args)}: entries, total, filters passed, one request`,
        [resources(items), total, true, 1],
        [
          page.items.map((i) => i.resource),
          page.pagination.total,
          Object.entries(args).every(([key, value]) => query.get(key) === String(value)),
          catalog.queries.length - before,
        ],
      );
    }
    const all = (await server.call("list_resources", {})).value as {
      items: { description: string }[];
    };
    row(
      "E-04",
      "a 10,000-character description is cut to 500 (README)",
      500,
      all.items[1]!.description.length,
    );
    await server.close();
  });

  it("E-05 a catalog failure is upstream_error within the time limit, and the server keeps running", async () => {
    const down = await startFakeCatalog(CATALOG);
    await down.close();
    const failing = await startFakeCatalog(CATALOG);
    failing.failWith = 500;
    const malformed = await startFakeCatalog(CATALOG);
    malformed.malformed = true;
    const hanging = await startFakeCatalog(CATALOG);
    hanging.hang = true;
    const variants = [
      ["a", down],
      ["b", failing],
      ["c", malformed],
      ["d", hanging],
    ] as const;
    for (const [id, fake] of variants) {
      // A 1 s time limit, and 1 s of slack for starting the request.
      const server = await startServer(
        base({ STELLAR_X402_DISCOVERY_URL: fake.url, STELLAR_X402_TIMEOUT_MS: "1000" }),
      );
      const begin = Date.now();
      const first = code(await server.call("list_resources", {}));
      const seconds = (Date.now() - begin) / 1000;
      const second = code(await server.call("list_resources", {}));
      row(
        `E-05${id}`,
        "upstream_error twice, the first within 2 s",
        ["upstream_error", "upstream_error", true],
        [first, second, seconds < 2],
      );
      await server.close();
    }
    await Promise.all([failing.close(), malformed.close(), hanging.close()]);
  });

  it("E-06 input failing a schema is the SDK's error and reaches no seller", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const server = await startServer(paying());
    const cases: [string, Record<string, unknown>][] = [
      ["list_resources", { limit: -1 }],
      ["get_resource", { method: "GET" }],
      ["call_paid_http", { url: `${fake.url}/ok`, method: "HEAD" }],
      ["list_resources", { foo: 1 }],
    ];
    for (const [tool, args] of cases) {
      const answer = await server.call(tool, args);
      row(
        "E-06",
        `${tool} ${JSON.stringify(args)}: -32602`,
        [true, true],
        [answer.isError, answer.text.includes("-32602")],
      );
    }
    row("E-06", "requests reaching the seller", 0, fake.requests.length);
    await server.close();
    await fake.close();
  });
});

describe("get_resource", () => {
  it("E-07 reads the example seller's terms and spends nothing", async () => {
    const before = await usdcBalance(keys.buyerPublic);
    const server = await startServer(base());
    const answer = await server.call("get_resource", httpArgs(weather()));
    await server.close();
    const value = answer.value as { status: number; paymentRequired: PaymentRequired };
    const offer = value.paymentRequired.accepts[0]!;
    row(
      "E-07",
      "402 at 10000 on testnet, valid ≤ 300 s",
      [402, PRICE, "stellar:testnet", true],
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
        unpaid: (res, t) => answer402(withOffers(t, { network: "stellar:pubnet" }))(res),
      },
    });
    const server = await startServer(base({ STELLAR_X402_MAX_RESPONSE_BYTES: "1000" }));
    const cases: [string, string, string][] = [
      ["a", "/free", "ok"],
      ["b", "/nohdr", "unsupported_payment"],
      ["c", "/deep", "ok"],
      ["d", "/gone", "resource_not_found"],
      ["e", "/boom", "upstream_error"],
      ["f", "/big", "response_too_large"],
      ["g", "/gzip", "response_too_large"],
      ["h", "/stall", "upstream_error"],
      ["i", "/redir", "unsafe_url"],
      ["j", "/pubnet402", "ok"],
    ];
    for (const [id, path, expected] of cases) {
      const freeBefore = hitsOf(fake, "/free");
      const begin = Date.now();
      const answer = await server.call("get_resource", httpArgs(`${fake.url}${path}`));
      // The 3 s time limit, and 1 s of slack.
      row(
        `E-08${id}`,
        `get_resource ${path}, within 4 s`,
        [expected, true],
        [code(answer), Date.now() - begin < 4_000],
      );
      if (path === "/redir")
        row("E-08i", "redirect not followed", freeBefore, hitsOf(fake, "/free"));
      if (path === "/pubnet402") {
        const value = answer.value as { status: number; paymentRequired: PaymentRequired };
        row(
          "E-08j",
          "terms returned as given",
          [402, "stellar:pubnet"],
          [value.status, value.paymentRequired.accepts[0]!.network],
        );
      }
    }
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
      // A public name pointing at 127.0.0.1 (public DNS): the switch opens only this machine's names.
      ["g", "get_resource", `${fake.url.replace("127.0.0.1", "127.0.0.1.nip.io")}/free`],
    ];
    for (const [id, tool, url] of refused)
      row(
        `E-09${id}`,
        `${tool} ${url}`,
        "unsafe_url",
        code(await server.call(tool, httpArgs(url))),
      );
    const local = fake.url.replace("127.0.0.1", "localhost");
    row(
      "E-09",
      "control: localhost and 127.0.0.1 pass with the switch",
      ["ok", "ok"],
      [
        code(await server.call("get_resource", httpArgs(`${local}/free`))),
        code(await server.call("get_resource", httpArgs(`${fake.url}/free`))),
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
      code(await strictServer.call("get_resource", httpArgs(`${fake.url}/free`))),
    );
    // The production path, with the switch off: a public https name resolved and checked by the
    // guard, then TLS. No seller of ours runs there; any 200 shows the request went through.
    row(
      "E-09h",
      "https://example.com/ without the switch passes the guard",
      ["ok", 200],
      await strictServer
        .call("get_resource", httpArgs("https://example.com/"))
        .then((answer) => [code(answer), (answer.value as { status?: number })?.status]),
    );
    await strictServer.close();
    row(
      "E-09",
      "nothing counted",
      false,
      existsSync(join(env.STELLAR_X402_STATE_DIR!, "spent.sqlite")),
    );
    row("E-09", "requests reaching the seller: the two controls only", 2, fake.requests.length);
    await fake.close();
  });
});

describe("call_paid_http refusals before signing", () => {
  let fake: FakeSeller;
  beforeAll(async () => {
    const other = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const offering = (...changes: Parameters<typeof withOffers>[1][]) => ({
      unpaid: (res: ServerResponse, copy: PaymentRequired) =>
        answer402(withOffers(copy, ...changes))(res),
    });
    fake = await startFakeSeller(terms, {
      "/paid": {},
      "/othasset": offering({ asset: other }),
      "/pubnet": offering({ network: "stellar:pubnet" }),
      "/long": offering({ maxTimeoutSeconds: 600 }),
      "/negative": offering({ amount: "-5" }),
      "/zero": offering({ amount: "0" }),
      "/upto": offering({ scheme: "upto" }),
      "/long-pricey": offering({ maxTimeoutSeconds: 600, amount: "20000" }),
      "/other-then-long": offering({ asset: other }, { maxTimeoutSeconds: 600 }),
      "/pricey": offering({ amount: "20000" }),
    });
  });
  afterAll(() => fake.close());

  it("E-10 to E-13a refuse with the first check that leaves no offer, and sign nothing", async () => {
    const server = await startServer(paying());
    const cases: [string, string, string][] = [
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
    for (const [id, path, expected] of cases)
      row(
        id,
        `call_paid_http ${path}`,
        expected,
        code(await server.call("call_paid_http", httpArgs(`${fake.url}${path}`))),
      );
    row("E-11…13a", "signed payments the seller received", 0, paidAt(fake));
    const withBody = httpArgs(`${fake.url}/paid`, { body: "{}" });
    row(
      "E-10",
      "call_paid_http GET with a body",
      "invalid_input",
      code(await server.call("call_paid_http", withBody)),
    );
    row(
      "E-10",
      "get_resource GET with a body (README: either seller tool)",
      "invalid_input",
      code(await server.call("get_resource", withBody)),
    );
    row("E-10", "requests reaching /paid", 0, hitsOf(fake, "/paid"));
    await server.close();
  });
});

describe("call_paid_http after signing (fake seller, no money moves)", () => {
  it("E-13b pays the offer within the limit when the seller lists two", async () => {
    const fake = await startFakeSeller(terms, {
      "/two": {
        unpaid: (res, t) => answer402(withOffers(t, { amount: "20000" }, { amount: "5000" }))(res),
        paid: (res) =>
          res.writeHead(200, { "payment-response": settlement(true, FAKE_HASH) }).end("{}"),
      },
    });
    const server = await startServer(paying());
    const answer = await server.call("call_paid_http", httpArgs(`${fake.url}/two`));
    const payment = (answer.value as Partial<PaidResult>).payment;
    const ledger = await latestLedger();
    const offer = terms.accepts[0]!;
    const signed = fake.requests.filter((r) => r.paid).map((r) => r.signed!);
    row(
      "E-13b",
      "one payment, the signed transfer: 5000 USDC from the buyer to the seller's payTo",
      [{ asset: offer.asset, from: keys.buyerPublic, to: offer.payTo, amount: "5000" }],
      signed.map(({ asset, from, to, amount }) => ({ asset, from, to, amount })),
    );
    // A ledger closes about every 5 s: the signature must stop being valid within the offer's own
    // time limit, and never later than 300 s (the server's cap), counted in ledgers.
    const ledgersLeft = signed[0]!.expirationLedger - ledger;
    row(
      "E-13b",
      `signature valid for ${ledgersLeft} more ledgers: within the offer's ${offer.maxTimeoutSeconds} s and 300 s`,
      [true, true],
      [ledgersLeft <= Math.ceil(offer.maxTimeoutSeconds / 5) + 1, ledgersLeft <= 61],
    );
    // A well-formed hash the fake made up is returned as is: the seller's word (W435).
    row(
      "E-13b",
      "result: ok, 5000, the settlement's hash",
      ["ok", "5000", FAKE_HASH],
      [code(answer), payment?.amount, payment?.transaction],
    );
    await server.close();
    await fake.close();
  });

  it("E-14 an unfunded payer is insufficient_funds, twice, with the cause only in the log", async () => {
    const xlmBefore = await xlmBalance(unfunded.publicKey());
    const server = await startServer(
      paying({
        STELLAR_X402_SECRET_KEY: unfunded.secret(),
        STELLAR_X402_DAILY_BUDGET: PRICE,
        STELLAR_X402_TIMEOUT_MS: "30000",
      }),
    );
    const first = await server.call("call_paid_http", httpArgs(weather()));
    const second = await server.call("call_paid_http", httpArgs(weather()));
    await server.close();
    row(
      "E-14",
      "both calls (the second is not over_budget: the amount came back)",
      ["insufficient_funds", "insufficient_funds"],
      [code(first), code(second)],
    );
    // A missing trustline fails in the asset contract (Error(Contract, #13), measured on testnet).
    row(
      "E-14",
      "cause in the log, not in the tool text",
      [true, false],
      [server.stderr().includes("Contract"), first.text.includes("Contract")],
    );
    row("E-14", "XLM unchanged", String(xlmBefore), String(await xlmBalance(unfunded.publicKey())));
  });

  it("E-14b a payer with a USDC trustline and nothing on it is insufficient_funds", async () => {
    // The common case on mainnet, a drained wallet: the asset contract fails with #10, not #13.
    const empty = Keypair.random();
    drained = empty.secret();
    await friendbot(empty.publicKey());
    await openUsdcTrustline(empty);
    const server = await startServer(
      paying({ STELLAR_X402_SECRET_KEY: empty.secret(), STELLAR_X402_TIMEOUT_MS: "30000" }),
    );
    const answer = await server.call("call_paid_http", httpArgs(weather()));
    await server.close();
    row(
      "E-14b",
      "insufficient_funds, the contract's #10 in the log only",
      ["insufficient_funds", true, false],
      [code(answer), server.stderr().includes("#10"), answer.text.includes("#10")],
    );
  });

  it("E-14c a seller that does not pay the network fees is refused before signing", async () => {
    // The exact scheme on Stellar requires the facilitator to pay the fees; upstream refuses to sign
    // otherwise. Today that is payment_failed (W434 asks whether it should be unsupported_payment).
    const fake = await startFakeSeller(terms, {
      "/unsponsored": {
        unpaid: (res, t) => answer402(withOffers(t, { extra: { areFeesSponsored: false } }))(res),
      },
    });
    const dir = freshDir();
    const server = await startServer(paying({ STELLAR_X402_STATE_DIR: dir }));
    const answer = await server.call("call_paid_http", httpArgs(`${fake.url}/unsponsored`));
    await server.close();
    row(
      "E-14c",
      "refused, nothing sent, the amount given back",
      ["payment_failed", 0, "0"],
      [code(answer), paidAt(fake), counted(dir)],
    );
    await fake.close();
  });

  it("E-24 a paid POST carries its body on the paid request too", async () => {
    const fake = await startFakeSeller(terms, { "/post": {} });
    const server = await startServer(paying());
    const body = '{"city":"Warsaw","days":3}';
    const answer = await server.call("call_paid_http", {
      url: `${fake.url}/post`,
      method: "POST",
      body,
    });
    await server.close();
    row(
      "E-24",
      "ok; the unpaid and the paid request both carry the body",
      ["ok", [body, body]],
      [code(answer), fake.requests.map((r) => r.body)],
    );
    await fake.close();
  });

  it("E-15 a refused payment is payment_rejected, without a hash, and stays counted", async () => {
    const fake = await startFakeSeller(terms, {
      "/rej-settle": {
        paid: (res) => res.writeHead(200, { "payment-response": settlement(false, "") }).end("{}"),
      },
      "/rej-402": { paid: (res) => answer402(terms)(res) },
      "/ok": {},
    });
    const server = await startServer(paying({ STELLAR_X402_DAILY_BUDGET: "20000" }));
    const answers = [];
    for (const path of ["/rej-settle", "/rej-402", "/ok"])
      answers.push(await server.call("call_paid_http", httpArgs(`${fake.url}${path}`)));
    row(
      "E-15",
      "rejected, rejected, then over the budget",
      ["payment_rejected", "payment_rejected", "over_budget"],
      answers.map(code),
    );
    row(
      "E-15",
      "no transaction in the rejections",
      [false, false],
      answers.slice(0, 2).map((a) => a.text.includes("transaction")),
    );
    row(
      "E-15",
      "signed payments received: one per rejection, none for the refused third",
      [1, 1, 0],
      [paidAt(fake, "/rej-settle"), paidAt(fake, "/rej-402"), paidAt(fake, "/ok")],
    );
    await server.close();
    await fake.close();
  });

  it("E-16 anything else after the payment left is payment_unknown, and stays counted", async () => {
    const fake = await startFakeSeller(terms, {
      "/stall": { paid: (res) => res.writeHead(200).write("part") },
      "/redir": { paid: (res) => res.writeHead(302, { location: `${fake.url}/free` }).end() },
      "/boom": { paid: (res) => res.writeHead(500).end() },
      "/big": { paid: (res) => res.writeHead(200).end("x".repeat(5_000)) },
      "/drop": { paid: (res) => res.socket?.destroy() },
      "/free": { unpaid: (res) => res.writeHead(200).end("{}") },
    });
    const dir = freshDir();
    const server = await startServer(
      paying({ STELLAR_X402_MAX_RESPONSE_BYTES: "1000", STELLAR_X402_STATE_DIR: dir }),
    );
    const paths: [string, string][] = [
      ["a", "/stall"],
      ["b", "/redir"],
      ["c", "/boom"],
      ["d", "/big"],
      ["e", "/drop"],
    ];
    for (const [id, path] of paths) {
      const begin = Date.now();
      const answer = await server.call("call_paid_http", httpArgs(`${fake.url}${path}`));
      // The 3 s time limit, and 1 s of slack.
      row(
        `E-16${id}`,
        `call_paid_http ${path}: sent, then unknown within 4 s`,
        ["payment_unknown", 1, true],
        [code(answer), paidAt(fake, path), Date.now() - begin < 4_000],
      );
    }
    row("E-16b", "redirect not followed", 0, hitsOf(fake, "/free"));
    row("E-16", "every amount stays counted", String(5 * Number(PRICE)), counted(dir));
    await server.close();
    await fake.close();
  });

  it("E-16f one deadline covers the whole call, not each request", async () => {
    // 2 s to the 402, ~1 s to sign (it simulates on testnet), 2.5 s to the paid answer: a limit per
    // request (5 s each) would let the call succeed at ~5.5 s; one 5 s limit for the call stops it.
    const fake = await startFakeSeller(terms, {
      "/slow": {
        unpaid: (res, t) => setTimeout(() => answer402(t)(res), 2_000),
        paid: (res) => setTimeout(() => res.writeHead(200).end("{}"), 2_500),
      },
    });
    const server = await startServer(paying({ STELLAR_X402_TIMEOUT_MS: "5000" }));
    const begin = Date.now();
    const answer = await server.call("call_paid_http", httpArgs(`${fake.url}/slow`));
    const seconds = (Date.now() - begin) / 1000;
    row(
      "E-16f",
      `sent, then unknown at the 5 s deadline (took ${seconds.toFixed(1)} s)`,
      ["payment_unknown", 1, true],
      [code(answer), paidAt(fake, "/slow"), seconds < 5.5],
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
      "/text": {
        paid: (res) => res.writeHead(200, { "content-type": "text/plain" }).end("hello"),
      },
    });
    const server = await startServer(paying());
    const result = async (path: string) => {
      const answer = await server.call("call_paid_http", httpArgs(`${fake.url}${path}`));
      return { code: code(answer), ...(answer.value as Partial<PaidResult>) };
    };
    const a = await result("/no-header");
    row(
      "E-17a",
      "no settlement header",
      ["ok", 200, null, PRICE, '{"ok":true}'],
      [a.code, a.status, a.payment?.transaction, a.payment?.amount, a.body],
    );
    const b = await result("/not-a-hash");
    row("E-17b", "a hash that is not one", ["ok", null], [b.code, b.payment?.transaction]);
    const c = await result("/500-settled");
    row(
      "E-17c",
      "500 with a settlement",
      ["ok", 500, FAKE_HASH],
      [c.code, c.status, c.payment?.transaction],
    );
    const d = await result("/text");
    row("E-17d", "content type passed on", ["ok", "text/plain"], [d.code, d.contentType]);
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
      code(await server.call("call_paid_http", httpArgs(`${fake.url}/ok`))),
    );
    // The server waits up to 5 s for a lock (busy_timeout in packages/mcp/src/daily.ts); this
    // process holds it for 8 s, so the wait runs out while the lock is still held.
    const holder = new DatabaseSync(join(env.STELLAR_X402_STATE_DIR!, "spent.sqlite"));
    holder.exec("BEGIN EXCLUSIVE");
    const begin = Date.now();
    const locked = code(await server.call("call_paid_http", httpArgs(`${fake.url}/ok`)));
    const seconds = (Date.now() - begin) / 1000;
    await new Promise((done) => setTimeout(done, Math.max(0, 8_000 - (Date.now() - begin))));
    holder.exec("ROLLBACK");
    holder.close();
    row(
      "E-18",
      `locked: payment_failed after the 5 s wait (took ${seconds.toFixed(1)} s), log names the lock`,
      ["payment_failed", true, true],
      [locked, seconds >= 4.5 && seconds < 8, server.stderr().includes("database is locked")],
    );
    row(
      "E-18",
      "after the lock is gone",
      "ok",
      code(await server.call("call_paid_http", httpArgs(`${fake.url}/ok`))),
    );
    row("E-18", "signed payments received: not the locked one", 2, paidAt(fake));
    await server.close();
    await fake.close();
  });

  it("E-19 the daily budget is shared, survives a restart and resets when the file is deleted", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    const dir = freshDir();
    const env = (daily: string) =>
      paying({ STELLAR_X402_STATE_DIR: dir, STELLAR_X402_DAILY_BUDGET: daily });
    const pay = async (server: RunningServer) =>
      code(await server.call("call_paid_http", httpArgs(`${fake.url}/ok`)));
    const [a, b] = await Promise.all([startServer(env("25000")), startServer(env("25000"))]);
    const seen = [await pay(a)];
    const afterFirst = existsSync(join(dir, "spent.sqlite"));
    seen.push(await pay(a));
    const paidBeforeB = paidAt(fake);
    seen.push(await pay(b));
    const bSent = paidAt(fake) - paidBeforeB;
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
    row("E-19", "database after A's first payment; B sent nothing", [true, 0], [afterFirst, bSent]);
    await fake.close();
  });

  it("E-20 two processes paying at the same moment pass the day once (5 rounds, a sample)", async () => {
    const fake = await startFakeSeller(terms, { "/ok": {} });
    for (let round = 1; round <= 5; round++) {
      const env = paying({ STELLAR_X402_DAILY_BUDGET: PRICE });
      const [p, q] = await Promise.all([startServer(env), startServer(env)]);
      const paidBefore = paidAt(fake);
      const answers = await Promise.all(
        [p, q].map((s) => s.call("call_paid_http", httpArgs(`${fake.url}/ok`))),
      );
      row(
        `E-20.${round}`,
        "one paid, one over the budget; one payment sent",
        [["ok", "over_budget"], 1],
        [answers.map(code).sort(), paidAt(fake) - paidBefore],
      );
      await Promise.all([p.close(), q.close()]);
    }
    await fake.close();
  });
});

describe("real payments on testnet (0.002 USDC)", () => {
  /** Pays the example seller once and checks it on Horizon: the transfer, both balances, the fees. */
  async function payAndCheck(id: string, env: Record<string, string>): Promise<void> {
    const buyerBefore = await usdcBalance(keys.buyerPublic);
    const sellerBefore = await usdcBalance(keys.sellerPublic);
    const xlmBefore = await xlmBalance(keys.buyerPublic);
    const server = await startServer(env);
    const answer = await server.call("call_paid_http", httpArgs(weather()));
    await server.close();
    const value = answer.value as Partial<PaidResult>;
    const hash = value.payment?.transaction ?? undefined;
    row(
      id,
      "paid result: the weather, on testnet, 10000 in USDC, a hash",
      ["ok", 200, true, "stellar:testnet", PRICE, terms.accepts[0]!.asset, true],
      [
        code(answer),
        value.status,
        value.body?.includes('"city":"Warsaw"') ?? false,
        value.payment?.network,
        value.payment?.amount,
        value.payment?.asset,
        /^[0-9a-f]{64}$/.test(hash ?? ""),
      ],
      hash,
    );
    row(
      id,
      "the transaction succeeded and moved 0.001 USDC from the buyer to the seller",
      [true, { from: keys.buyerPublic, to: keys.sellerPublic, amount: "0.0010000" }],
      [hash ? await succeeded(hash) : false, hash ? await usdcTransfer(hash) : {}],
      hash,
    );
    const buyerAfter = await balanceAfter(keys.buyerPublic, buyerBefore);
    const sellerAfter = await balanceAfter(keys.sellerPublic, sellerBefore);
    row(
      id,
      "buyer −10000, seller +10000, buyer XLM unchanged (the facilitator pays fees)",
      ["-10000", "10000", "0"],
      [
        String(buyerAfter - buyerBefore),
        String(sellerAfter - sellerBefore),
        String((await xlmBalance(keys.buyerPublic)) - xlmBefore),
      ],
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
      STELLAR_X402_DAILY_BUDGET: PRICE,
    });
    await payAndCheck("E-22a", env);
    const before = await usdcBalance(keys.buyerPublic);
    const y = await startServer(env);
    row(
      "E-22b",
      "another process, same directory",
      "over_budget",
      code(await y.call("call_paid_http", httpArgs(weather()))),
    );
    await y.close();
    // A ledger closes about every 5 s: a payment b had wrongly sent would show by then.
    await new Promise((done) => setTimeout(done, 6_000));
    const afterB = await usdcBalance(keys.buyerPublic);
    const z = await startServer(
      paying({ STELLAR_X402_TIMEOUT_MS: "30000", STELLAR_X402_MAX_PER_CALL: "9999" }),
    );
    row(
      "E-22c",
      "per-call limit under the price",
      "over_price_limit",
      code(await z.call("call_paid_http", httpArgs(weather()))),
    );
    await z.close();
    await new Promise((done) => setTimeout(done, 6_000));
    row(
      "E-22",
      "buyer balance unchanged after b and after c",
      [String(before), String(before)],
      [String(afterB), String(await usdcBalance(keys.buyerPublic))],
    );
  });
});

it("E-23 no secret appears in anything the servers wrote", () => {
  const all = captured.join("\n");
  const secrets = {
    buyer: keys.buyerSecret,
    "buyer without its S": keys.buyerSecret.slice(1),
    unfunded: unfunded.secret(),
    "drained (E-14b)": drained,
    "malformed key of E-01l": "SNOTAVALIDKEY0123456789",
  };
  for (const [name, secret] of Object.entries(secrets).filter(([, value]) => value !== ""))
    row(
      "E-23",
      `no ${name} secret in ${captured.length} captures from ${started.count} processes`,
      false,
      all.includes(secret),
    );
});
