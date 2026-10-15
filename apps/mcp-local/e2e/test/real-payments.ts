import { describe, it } from "vitest";
import { code, type PaidResult, startServer } from "../src/cli.js";
import { succeeded, usdcBalance, usdcTransfer, xlmBalance } from "../src/horizon.js";
import { row } from "../src/results.js";
import {
  balanceAfter,
  freshDir,
  httpArgs,
  keys,
  paying,
  PRICE,
  terms,
  weather,
} from "./context.js";

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
