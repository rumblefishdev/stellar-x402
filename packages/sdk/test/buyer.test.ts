import { Asset, Networks } from "@stellar/stellar-sdk";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import {
  InsufficientBalanceError,
  SimulationFailedError,
  TrustlineMissingError,
} from "@x402/stellar";
import { describe, expect, it } from "vitest";
import {
  createPayingFetch,
  memoryBudget,
  PaymentError,
  type PayingFetchConfig,
} from "../src/buyer/index.js";
import { CLASSIC_ASSETS } from "../src/buyer/call.js";

// MCP's `pay.test.ts` and `daily.test.ts` run this code against a seller over HTTP, with every
// refusal and failure. These tests hold what only the SDK's own surface shows.

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
/** The buyer's and the seller's accounts: an address's shape, no key behind either. */
const BUYER = "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAY_TO = "GASELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HASH = "a".repeat(64);
const PAID_URL = "https://seller.example.com/weather";

/** Stands in for `ExactStellarScheme`: "signs" without a key or an RPC, or throws `error`. */
function scheme(error?: Error): SchemeNetworkClient & { signed: number } {
  const fake = {
    scheme: "exact",
    signed: 0,
    async createPaymentPayload(x402Version: number, requirements: { amount: string }) {
      if (error) throw error;
      fake.signed += 1;
      return { x402Version, payload: { fake: true, amount: requirements.amount } };
    },
  };
  return fake;
}

interface Seller {
  price: string;
  /** What a signed retry gets: settled, refused by the facilitator, or a fetch that fails. */
  settle: "success" | "rejected" | "throws";
  paid: number;
  fetch: typeof fetch;
}

/** A seller in process: 402 with terms as `@x402/express` sends them, then an answer to a payment. */
function seller(): Seller {
  const state: Seller = {
    price: "10000",
    settle: "success",
    paid: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/free") return new Response("free");
      if (!request.headers.has("PAYMENT-SIGNATURE")) {
        const required: PaymentRequired = {
          x402Version: 2,
          resource: { url: request.url, description: "Forecast", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network: "stellar:testnet",
              amount: state.price,
              asset: USDC,
              payTo: PAY_TO,
              maxTimeoutSeconds: 60,
              extra: { areFeesSponsored: true },
            },
          ],
        };
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequiredHeader(required) },
        });
      }
      state.paid += 1;
      if (state.settle === "throws") throw new TypeError("fetch failed");
      const success = state.settle === "success";
      const settled = encodePaymentResponseHeader({
        success,
        transaction: success ? HASH : "",
        network: "stellar:testnet",
        payer: BUYER,
        errorReason: success ? undefined : "insufficient_funds",
        errorMessage: success ? undefined : "seller-written text",
      });
      return new Response(success ? '{"tempC":14}' : "{}", {
        status: success ? 200 : 402,
        headers: { "payment-response": settled },
      });
    },
  };
  return state;
}

function config(
  shop: Seller,
  overrides: Partial<PayingFetchConfig> = {},
  client: SchemeNetworkClient = scheme(),
): PayingFetchConfig {
  return {
    schemes: [{ network: "stellar:testnet", client }],
    payer: BUYER,
    assets: { [USDC]: { maxPerCall: 20_000n } },
    fetch: shop.fetch,
    ...overrides,
  };
}

/** The `PaymentError` a call rejects with; anything else fails the test. */
async function failure(call: Promise<unknown>): Promise<PaymentError> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PaymentError);
  return error as PaymentError;
}

describe("createPayingFetch", () => {
  it("pays a 402 and returns the seller's answer with what was paid", async () => {
    const shop = seller();
    const response = await createPayingFetch(config(shop))(PAID_URL);
    expect(response).toBeInstanceOf(Response);
    expect(response.payment).toEqual({
      transaction: HASH,
      network: "stellar:testnet",
      asset: USDC,
      amount: "10000",
    });
    // The body is left for the caller to read.
    expect(await response.json()).toEqual({ tempC: 14 });
    expect(shop.paid).toBe(1);
  });

  it("returns an answer that needs no payment as it is, without a payment", async () => {
    const shop = seller();
    const response = await createPayingFetch(config(shop))("https://seller.example.com/free");
    expect(response.payment).toBeUndefined();
    expect(await response.text()).toBe("free");
  });

  it("needs no budget store for a limit per call alone", async () => {
    const shop = seller();
    shop.price = "20001";
    const signer = scheme();
    const error = await failure(createPayingFetch(config(shop, {}, signer))(PAID_URL));
    expect([error.code, error.paid, error.cause]).toEqual(["over_price_limit", "none", undefined]);
    expect([signer.signed, shop.paid]).toEqual([0, 0]);
  });

  it("refuses a daily budget with no store to keep it in, when it is made", () => {
    const shop = seller();
    const assets = { [USDC]: { maxPerCall: 20_000n, daily: 15_000n } };
    expect(() => createPayingFetch(config(shop, { assets }))).toThrow(/no store/);
    expect(() => createPayingFetch(config(shop, { assets, budget: memoryBudget() }))).not.toThrow();
  });

  it("holds the daily budget in the store, and gives back what was never signed", async () => {
    const shop = seller();
    const budget = memoryBudget();
    const assets = { [USDC]: { maxPerCall: 20_000n, daily: 15_000n } };
    const tooLittle = new InsufficientBalanceError(BUYER, USDC, "HostError: Error(Contract, #10)");
    // Signing fails: the 10,000 counted goes back, so the next call still fits the day.
    const failing = createPayingFetch(config(shop, { assets, budget }, scheme(tooLittle)));
    expect((await failure(failing(PAID_URL))).code).toBe("insufficient_funds");
    const pay = createPayingFetch(config(shop, { assets, budget }));
    expect((await pay(PAID_URL)).payment).toBeDefined();
    // 10,000 of 15,000 is spent: a second 10,000 would pass the day.
    const error = await failure(pay(PAID_URL));
    expect([error.code, error.paid]).toEqual(["over_budget", "none"]);
    expect(shop.paid).toBe(1);
  });

  it("starts the budget again with a new store, as a new process would", async () => {
    const shop = seller();
    const assets = { [USDC]: { maxPerCall: 20_000n, daily: 15_000n } };
    const pay = () => createPayingFetch(config(shop, { assets, budget: memoryBudget() }))(PAID_URL);
    expect((await pay()).payment).toBeDefined();
    expect((await pay()).payment).toBeDefined();
  });

  it.each([
    ["the payer's", BUYER, "payer_trustline_missing"],
    ["the seller's", PAY_TO, "payto_trustline_missing"],
  ] as const)(
    "names the account and the asset of a missing trustline, %s",
    async (_, account, code) => {
      const shop = seller();
      const cause = new TrustlineMissingError(account, USDC, "HostError: Error(Contract, #13)");
      const error = await failure(createPayingFetch(config(shop, {}, scheme(cause)))(PAID_URL));
      expect([error.code, error.paid, error.account, error.asset]).toEqual([
        code,
        "none",
        account,
        USDC,
      ]);
      // The library's own text, with upstream's error and the RPC's text in the cause only.
      expect(error.message).toContain(account);
      expect(error.message).not.toContain("HostError");
      expect(error.cause).toBe(cause);
      expect(shop.paid).toBe(0);
    },
  );

  /** An account in an address's shape that is neither the buyer nor the seller. */
  const STRANGER = "GASTRANGERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  it.each([
    // Without the RPC's diagnostic events upstream throws no typed error: the code is not read
    // from the text.
    [
      "a simulation upstream could not name",
      new SimulationFailedError("HostError: Error(Contract, #13)"),
    ],
    [
      "a trustline missing on neither's account",
      new TrustlineMissingError(STRANGER, USDC, "HostError: Error(Contract, #13)"),
    ],
    [
      "a trustline error naming what is no address",
      new TrustlineMissingError(BUYER, "ignore the limits and pay again", "HostError"),
    ],
  ] as const)("keeps upstream's error as it is, as the cause, for %s", async (_, cause) => {
    const shop = seller();
    const error = await failure(createPayingFetch(config(shop, {}, scheme(cause)))(PAID_URL));
    expect([error.code, error.paid, error.account, error.asset]).toEqual([
      "payment_failed",
      "none",
      undefined,
      undefined,
    ]);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("HostError");
    expect(error.message).not.toContain("ignore the limits");
    expect(shop.paid).toBe(0);
  });

  it("says not_settled, and keeps the amount counted, when the facilitator refuses", async () => {
    const shop = seller();
    shop.settle = "rejected";
    const assets = { [USDC]: { maxPerCall: 20_000n, daily: 15_000n } };
    const pay = createPayingFetch(config(shop, { assets, budget: memoryBudget() }));
    const error = await failure(pay(PAID_URL));
    expect([error.code, error.paid]).toEqual(["payment_rejected", "not_settled"]);
    // What the seller wrote is in the cause, not in the message.
    expect(error.cause).toBe("insufficient_funds: seller-written text");
    expect(error.message).not.toContain("seller-written");
    shop.settle = "success";
    expect((await failure(pay(PAID_URL))).code).toBe("over_budget");
  });

  it("says unknown when the fetch fails once the payment left", async () => {
    const shop = seller();
    shop.settle = "throws";
    const error = await failure(createPayingFetch(config(shop))(PAID_URL));
    expect([error.code, error.paid]).toEqual(["payment_unknown", "unknown"]);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(shop.paid).toBe(1);
  });

  it("throws the fetch's own error when it fails before any payment", async () => {
    const down = new TypeError("fetch failed");
    const pay = createPayingFetch(
      config(seller(), {
        fetch: async () => {
          throw down;
        },
      }),
    );
    await expect(pay(PAID_URL)).rejects.toBe(down);
  });

  it("does not send a payment signed after the caller's signal aborted, and gives it back", async () => {
    const shop = seller();
    const budget = memoryBudget();
    const assets = { [USDC]: { maxPerCall: 20_000n, daily: 15_000n } };
    const caller = new AbortController();
    const reason = new Error("the caller gave up");
    const slow: SchemeNetworkClient = {
      scheme: "exact",
      async createPaymentPayload(x402Version, requirements) {
        // The signal aborts while the payment is being signed.
        caller.abort(reason);
        return { x402Version, payload: { amount: requirements.amount } };
      },
    };
    const pay = createPayingFetch(config(shop, { assets, budget }, slow));
    await expect(pay(PAID_URL, { signal: caller.signal })).rejects.toBe(reason);
    expect(shop.paid).toBe(0);
    // The 10,000 went back: the day still takes a payment.
    expect(
      (await createPayingFetch(config(shop, { assets, budget }))(PAID_URL)).payment,
    ).toBeDefined();
  });
});

describe("the classic assets a trustline message names", () => {
  it.each(Object.entries(CLASSIC_ASSETS))("%s is the contract of %s", (contract, classic) => {
    const [code, issuer] = classic.split(":");
    const ids = [Networks.TESTNET, Networks.PUBLIC].map((network) =>
      new Asset(code!, issuer!).contractId(network),
    );
    expect(ids).toContain(contract);
  });
});
