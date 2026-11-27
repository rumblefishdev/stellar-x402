import type { ServerResponse } from "node:http";
import type { PaymentRequired } from "@x402/core/types";
import { afterAll, beforeAll, describe, it } from "vitest";
import { code, startServer } from "../src/cli.js";
import { answer402, type FakeSeller, startFakeSeller, withOffers } from "../src/fakes.js";
import { row } from "../src/results.js";
import { hitsOf, httpArgs, paidAt, paying, terms, unfunded } from "./context.js";

describe("call_paid_http refusals before signing", () => {
  const other = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  let fake: FakeSeller;
  beforeAll(async () => {
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

  it("E-26 holds the seller to the listing the agent passes, and signs nothing", async () => {
    // The listing as search_resources gives it, for the fake's /paid, which answers the real terms.
    const listing = (change: Partial<PaymentRequired["accepts"][number]> = {}) => ({
      resource: `${fake.url}/paid`,
      type: "http",
      accepts: [{ ...terms.accepts[0]!, ...change }],
      input: { type: "http", method: "GET" },
    });
    const price = BigInt(terms.accepts[0]!.amount);
    const server = await startServer(paying());
    const cases: [string, string, unknown, string][] = [
      [
        "E-26a",
        "a live price above the listing's",
        listing({ amount: String(price - 1n) }),
        "price_raised",
      ],
      [
        "E-26b",
        "a live payTo other than the listing's",
        listing({ payTo: unfunded.publicKey() }),
        "payto_changed",
      ],
      ["E-26c", "an asset the listing does not offer", listing({ asset: other }), "terms_changed"],
      [
        "E-26d",
        "a listing for another URL",
        { ...listing(), resource: `${fake.url}/othasset` },
        "invalid_input",
      ],
    ];
    for (const [id, what, chosen, expected] of cases)
      row(
        id,
        `call_paid_http /paid with ${what}`,
        expected,
        code(
          await server.call("call_paid_http", httpArgs(`${fake.url}/paid`, { listing: chosen })),
        ),
      );
    row("E-26", "signed payments the seller received", 0, paidAt(fake));
    await server.close();
  });
});
