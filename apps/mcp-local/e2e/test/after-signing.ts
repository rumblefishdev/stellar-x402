import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, it } from "vitest";
import { code, type PaidResult, type RunningServer, startServer } from "../src/cli.js";
import { answer402, FAKE_HASH, settlement, startFakeSeller, withOffers } from "../src/fakes.js";
import { friendbot, latestLedger, openUsdcTrustline, xlmBalance } from "../src/horizon.js";
import { row } from "../src/results.js";
import {
  counted,
  freshDir,
  hitsOf,
  httpArgs,
  keys,
  paidAt,
  paying,
  PRICE,
  terms,
  unfunded,
  weather,
} from "./context.js";

/** The secret of E-14b's account, searched for by E-23 too. */
export let drained = "";

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
