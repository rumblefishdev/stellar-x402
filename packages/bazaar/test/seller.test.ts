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

  it("takes extra up to 4 KiB and 8 offers; one more refuses the whole listing (row 9)", () => {
    const at = (size: number) => ({ ...offer, extra: extraOf(size) });
    expect(sellerOffers([at(LIMITS.offerExtraBytes)], key)).toMatchObject({ ok: true });
    expect(sellerOffers([at(LIMITS.offerExtraBytes + 1)], key)).toEqual({
      ok: false,
      reason: "too_large",
      detail: "accepts.extra",
      bytes: LIMITS.offerExtraBytes + 1,
    });
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

  it("refuses a paid requirement whose extra is over 4 KiB in the header too (rows 9, 22)", () => {
    const payload = {
      x402Version: 2,
      resource: { url },
      extensions: { bazaar },
    } as unknown as PaymentPayload;
    const big = { ...offer, extra: extraOf(LIMITS.offerExtraBytes + 1) };
    expect(validate(payload, big)).toEqual({
      ok: false,
      reason: "too_large",
      detail: "requirements.extra",
      bytes: LIMITS.offerExtraBytes + 1,
    });
    expect(validate(payload, offer)).toMatchObject({ ok: true });
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

  it("leaves out an example over 16 KiB", () => {
    const big = { text: "x".repeat(LIMITS.exampleInputBytes) };
    expect(sellerRequest(url, { method: "GET", queryParams: big })).toEqual({ url, method: "GET" });
    expect(sellerRequest(url, { method: "POST", body: big })).toEqual({
      url,
      method: "POST",
      body: "{}",
    });
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
