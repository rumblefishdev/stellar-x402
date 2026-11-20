import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  listingFromSeller,
  normalize,
  sameListing,
  sellerOffers,
  sellerRequest,
  toolCall,
  validate,
} from "../src/index.js";

const offer = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "10000",
  payTo: "GPAYTO",
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;

const key = { network: "stellar:testnet", payTo: "GPAYTO" };
const url = "https://seller.example.com/weather";
const bazaar = { info: { input: { type: "http", method: "GET" } } };

/** A seller's 402 answer, as `PAYMENT-REQUIRED` decodes it. */
function answer(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, description: "Weather by city" },
    accepts: [offer],
    extensions: { bazaar },
    ...overrides,
  } as PaymentRequired;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** An `extra` whose JSON is exactly `size` bytes. */
const extraOf = (size: number) => ({ pad: "x".repeat(size - bytes({ pad: "" })) });

describe("seller offers (0063 rows 7-9)", () => {
  it("keeps only the offers to the key's network and payTo (row 7)", () => {
    const result = sellerOffers(
      [offer, { ...offer, payTo: "GOTHER" }, { ...offer, network: "stellar:pubnet" }],
      key,
    );
    expect(result).toEqual({ ok: true, offers: [offer], droppedFields: 0 });
  });

  it("refuses a listing with no offer to the key's network and payTo (row 6)", () => {
    expect(sellerOffers([{ ...offer, payTo: "GOTHER" }], key)).toMatchObject({
      ok: false,
      reason: "other_pay_to",
    });
  });

  it("keeps the spec's seven fields of an offer and counts the dropped ones (row 8)", () => {
    const padded = { ...offer, description: "v1 name", resource: "https://x", mimeType: "a/b" };
    const result = sellerOffers([padded], key);
    expect(result).toEqual({ ok: true, offers: [offer], droppedFields: 3 });
  });

  it("refuses an offer that is not a payment requirement", () => {
    expect(sellerOffers([{ ...offer, amount: 5 }], key)).toMatchObject({
      ok: false,
      reason: "invalid_offer",
    });
  });

  it("takes an extra of any size and 8 offers; a ninth refuses the whole listing (row 9)", () => {
    expect(sellerOffers([{ ...offer, extra: extraOf(5 * 1024) }], key)).toMatchObject({ ok: true });
    const assets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...offer, asset: `C${i}` }));
    expect(sellerOffers(assets(LIMITS.offers), key)).toMatchObject({ ok: true });
    expect(sellerOffers(assets(LIMITS.offers + 1), key)).toEqual({
      ok: false,
      reason: "too_large",
      detail: "accepts",
      bytes: undefined,
    });
  });

  it("leaves a paid requirement's extra to the whole listing's cap (0063, 17e)", () => {
    const payload = {
      x402Version: 2,
      resource: { url },
      extensions: { bazaar },
    } as unknown as PaymentPayload;
    const big = { ...offer, extra: extraOf(5 * 1024) };
    expect(validate(payload, big)).toMatchObject({ ok: true });
  });
});

describe("the request to the seller (0063 row 4)", () => {
  it("sends a GET's example query, and no query without one", () => {
    expect(sellerRequest(url, { method: "GET", queryParams: { city: "Warsaw", days: 3 } })).toEqual(
      { url: `${url}?city=Warsaw&days=3`, method: "GET" },
    );
    expect(sellerRequest(url, { method: "GET" })).toEqual({ url, method: "GET" });
  });

  it("sends a POST's example body as JSON, and {} without one", () => {
    expect(sellerRequest(url, { method: "POST", body: { city: "Warsaw" } })).toEqual({
      url,
      method: "POST",
      body: '{"city":"Warsaw"}',
    });
    expect(sellerRequest(url, { method: "POST" })).toEqual({ url, method: "POST", body: "{}" });
  });

  it("sends an example of any size: the bazaar block's 32 KiB bounds it", () => {
    const big = { text: "x".repeat(20 * 1024) };
    expect(sellerRequest(url, { method: "POST", body: big })).toEqual({
      url,
      method: "POST",
      body: JSON.stringify(big),
    });
  });
});

describe("the unpaid tool call to an MCP seller (0063 row 5)", () => {
  it("calls the listing's tool with its example arguments, {} without one", () => {
    expect(toolCall({ toolName: "weather", example: { city: "Warsaw" } })).toEqual({
      name: "weather",
      arguments: { city: "Warsaw" },
    });
    expect(toolCall({ toolName: "weather" })).toEqual({ name: "weather", arguments: {} });
  });
});

describe("a listing from the seller's 402 (0063 row 1)", () => {
  it("takes the text, the bazaar block and the offers from the seller, the URL from the listing", () => {
    const result = listingFromSeller(
      answer({ resource: { url: "https://elsewhere.example.com/x", description: "Seller's" } }),
      { url, ...key },
    );
    expect(result).toMatchObject({
      ok: true,
      droppedFields: 0,
      entry: {
        key: { ...key, method: "GET", resourceUrl: url },
        resource: { resource: url, description: "Seller's", accepts: [offer] },
      },
    });
  });

  it("hands back the listing's input, so a check can ask with its method and example (0155)", () => {
    const post = { info: { input: { type: "http", method: "POST", body: { city: "Warsaw" } } } };
    const result = listingFromSeller(answer({ extensions: { bazaar: post } }), { url, ...key });
    expect(result).toMatchObject({
      ok: true,
      entry: { key: { method: "POST" } },
      input: { type: "http", method: "POST", body: { city: "Warsaw" } },
    });
  });

  it("cuts a long description in the seller's own 402 as in a payment's copy (0063)", () => {
    const long = answer({ resource: { url, description: "d".repeat(600) } });
    const result = listingFromSeller(long, { url, ...key });
    expect(result.ok && result.entry.resource.description).toBe("d".repeat(499) + "…");
  });

  it("refuses an answer without a listing, or with one that breaks a rule", () => {
    expect(listingFromSeller(answer({ extensions: {} }), { url, ...key })).toMatchObject({
      ok: false,
      reason: "no_listing",
    });
    expect(
      listingFromSeller(answer({ extensions: { bazaar: { info: {} } } }), { url, ...key }),
    ).toMatchObject({ ok: false, reason: "invalid_info" });
    expect(
      listingFromSeller(answer({ accepts: [{ ...offer, payTo: "GOTHER" }] }), { url, ...key }),
    ).toMatchObject({ ok: false, reason: "other_pay_to" });
  });

  it("refuses a listing over 36 KiB as a whole, though each field is within its limit", () => {
    // A `bazaar` block within its 32 KiB and an offer whose `extra` takes the listing past 36 KiB.
    const withExtra = (size: number) =>
      answer({
        accepts: [{ ...offer, extra: extraOf(size) }],
        extensions: {
          bazaar: {
            info: { ...bazaar.info, output: { type: "json", example: "x".repeat(30 * 1024) } },
          },
        },
      });
    expect(listingFromSeller(withExtra(1024), { url, ...key })).toMatchObject({ ok: true });
    const result = listingFromSeller(withExtra(8 * 1024), { url, ...key });
    expect(result).toMatchObject({ ok: false, reason: "too_large", detail: "listing" });
    expect(result.ok === false && result.bytes).toBeGreaterThan(LIMITS.listingBytes);
  });
});

describe("whether a payment's copy matches the stored listing (0063 row 2)", () => {
  const payload = (description: string) =>
    ({
      x402Version: 2,
      resource: { url, description },
      extensions: { bazaar },
    }) as unknown as PaymentPayload;
  const echoed = (description: string, paid = offer) => {
    const result = validate(payload(description), paid);
    if (!result?.ok) throw new Error(JSON.stringify(result));
    return normalize(result, paid).resource;
  };
  const stored: DiscoveryResource = {
    ...echoed("Weather by city"),
    accepts: [offer, { ...offer, asset: "COTHER" }],
    lastUpdated: "2026-10-28T00:00:00.000Z",
  };

  it("matches when the text is the same and the paid offer is one of the stored ones", () => {
    expect(sameListing(stored, echoed("Weather by city"))).toBe(true);
    expect(sameListing(stored, echoed("Weather by city", { ...offer, asset: "COTHER" }))).toBe(
      true,
    );
  });

  it("differs on other text and on an offer not stored, not on fields outside the seven", () => {
    expect(sameListing(stored, echoed("Something else"))).toBe(false);
    expect(sameListing(stored, echoed("Weather by city", { ...offer, amount: "1" }))).toBe(false);
    const padded = { ...offer, description: "v1 name" } as PaymentRequirements;
    expect(sameListing(stored, echoed("Weather by city", padded))).toBe(true);
  });
});
