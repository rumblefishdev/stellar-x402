import { describe, it } from "vitest";
import { code, type PaidResult, startServer } from "../src/cli.js";
import { succeeded, usdcBalance, usdcTransfer, xlmBalance } from "../src/horizon.js";
import { row } from "../src/results.js";
import {
  balanceAfter,
  example,
  facilitator,
  freshDir,
  httpArgs,
  keys,
  paying,
  PRICE,
  terms,
  weather,
} from "./context.js";

/**
 * A real payment waits for signing (up to 14.5 s measured) and for the facilitator's settle budget
 * (30 s by default), and must still stay under the MCP client's own 60 s.
 */
const PAYMENT_LIMIT_MS = "55000";

describe("real payments on testnet (0.003 USDC)", () => {
  /** Pays the example seller once and checks it on Horizon: the transfer, both balances, the fees. */
  async function payAndCheck(
    id: string,
    env: Record<string, string>,
    url = weather(),
  ): Promise<void> {
    const buyerBefore = await usdcBalance(keys.buyerPublic);
    const sellerBefore = await usdcBalance(keys.sellerPublic);
    const xlmBefore = await xlmBalance(keys.buyerPublic);
    const server = await startServer(env);
    const answer = await server.call("call_paid_http", httpArgs(url));
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
    await payAndCheck("E-21", paying({ STELLAR_X402_TIMEOUT_MS: PAYMENT_LIMIT_MS }));
  });

  it("E-22 pays once more, then the shared budget and the price limit refuse", async () => {
    const dir = freshDir();
    const env = paying({
      STELLAR_X402_TIMEOUT_MS: PAYMENT_LIMIT_MS,
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
    const z = await startServer(paying({ STELLAR_X402_MAX_PER_CALL: "9999" }));
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

  it("E-25 finds the example seller with search_resources on our facilitator, and pays it", async () => {
    // E-21's payment cataloged the seller; the seller check runs after the settle answer (ADR 0008).
    const env = paying({
      STELLAR_X402_TIMEOUT_MS: PAYMENT_LIMIT_MS,
      STELLAR_X402_DISCOVERY_URL: facilitator.url,
    });
    const args = { query: "current temperature for a city" };
    const server = await startServer(env);
    let answer = await server.call("search_resources", args);
    for (let i = 0; i < 20 && found(answer) === undefined; i++) {
      await new Promise((done) => setTimeout(done, 500));
      answer = await server.call("search_resources", args);
    }
    await server.close();
    const hit = found(answer);
    const route = (await (
      await fetch(`${facilitator.url}/discovery/search?${new URLSearchParams(args)}`)
    ).json()) as { resources: { resource: string }[]; partialResults: boolean };
    const value = answer.value as { items: { resource: string }[]; partialResults: boolean };
    row(
      "E-25",
      "search finds the example seller on testnet, in the route's order, partialResults as the route",
      ["ok", true, "stellar:testnet", route.resources.map((r) => r.resource), route.partialResults],
      [
        code(answer),
        hit !== undefined,
        hit?.accepts[0]?.network,
        value.items?.map((i) => i.resource),
        value.partialResults,
      ],
    );
    if (hit === undefined) return;
    await payAndCheck("E-25", env, `${hit.resource}?city=Warsaw`);
  });

  /** The example seller's weather listing among a search answer's items. */
  function found(answer: { value?: unknown }) {
    const items = (answer.value as { items?: SearchItem[] } | undefined)?.items ?? [];
    return items.find((item) => item.resource.startsWith(`${example.url}/weather`));
  }
});

interface SearchItem {
  resource: string;
  accepts: { network: string }[];
}
