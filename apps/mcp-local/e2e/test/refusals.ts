import type { ServerResponse } from "node:http";
import type { PaymentRequired } from "@x402/core/types";
import { afterAll, beforeAll, describe, it } from "vitest";
import { code, startServer } from "../src/cli.js";
import { answer402, type FakeSeller, startFakeSeller, withOffers } from "../src/fakes.js";
import { row } from "../src/results.js";
import { hitsOf, httpArgs, paidAt, paying, terms } from "./context.js";

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
