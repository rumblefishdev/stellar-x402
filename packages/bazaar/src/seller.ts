import { PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { deepEqual } from "@x402/core/utils";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { LIMITS, type BazaarRejectReason } from "./limits.js";
import { normalize, type NormalizedEntry } from "./normalize.js";
import { sellerOffers, type OffersResult } from "./offers.js";
import { serializedBytes, validate, type ValidateOptions } from "./validate.js";

/** Methods whose request carries a body, as upstream's `BodyDiscoveryInfo` names them. */
const BODY_METHODS = ["POST", "PUT", "PATCH"];

/** The example when its JSON fits `LIMITS.exampleInputBytes`, else nothing. */
function example(value: unknown): unknown {
  const bytes = serializedBytes(value);
  return bytes !== undefined && bytes <= LIMITS.exampleInputBytes ? value : undefined;
}

/**
 * The unpaid request that asks the seller for its listing (0063): the listing's method on its
 * concrete URL, with the listing's example input, since a route that needs a parameter answers 400
 * without one. `queryParams` go into the query; a body method sends `body` as JSON, or `{}`. An
 * unpaid request is answered with a 402 before the route runs, so the example is not trusted.
 */
export function sellerRequest(
  resourceUrl: string,
  input: { method: string; queryParams?: unknown; body?: unknown },
): { url: string; method: string; body?: string } {
  const url = new URL(resourceUrl);
  const query = example(input.queryParams);
  if (typeof query === "object" && query !== null) {
    for (const [name, value] of Object.entries(query))
      url.searchParams.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  const request = { url: url.href, method: input.method };
  if (!BODY_METHODS.includes(input.method)) return request;
  return { ...request, body: JSON.stringify(example(input.body) ?? {}) };
}

export type SellerListing =
  | { ok: true; entry: NormalizedEntry; droppedFields: number; routeTemplateIgnored: boolean }
  | {
      ok: false;
      reason: BazaarRejectReason | Extract<OffersResult, { ok: false }>["reason"] | "no_listing";
      detail?: string;
      bytes?: number;
    };

/**
 * The listing as the seller's own 402 states it (0063): its text, its `extensions.bazaar` and its
 * offers to the key's network and `payTo`, under the same rules as a payment's copy. The URL is the
 * listing's, the one that answered, whatever URL the seller's answer names.
 */
export function listingFromSeller(
  paymentRequired: PaymentRequired,
  listing: { url: string; network: string; payTo: string },
  options: ValidateOptions = {},
): SellerListing {
  const offers = sellerOffers(paymentRequired.accepts, listing);
  if (!offers.ok) return offers;
  const [first] = offers.offers;
  const payload = {
    x402Version: paymentRequired.x402Version,
    resource: { ...paymentRequired.resource, url: listing.url },
    extensions: paymentRequired.extensions,
  } as unknown as PaymentPayload;
  const result = validate(payload, first!, options);
  if (!result) return { ok: false, reason: "no_listing" };
  if (!result.ok) return result;
  const { key, keyVersion, resource } = normalize(result, first!);
  const listed = { ...resource, accepts: offers.offers };
  const bytes = serializedBytes(listed);
  if (bytes === undefined || bytes > LIMITS.listingBytes)
    return { ok: false, reason: "too_large", detail: "listing", bytes };
  return {
    ok: true,
    entry: { key, keyVersion, resource: listed },
    droppedFields: offers.droppedFields,
    routeTemplateIgnored: result.routeTemplateIgnored,
  };
}

/**
 * Whether a payment's copy of a listing says what the stored listing says: the same fields, and
 * its paid offer, cut to the seven fields, among the stored offers (0063). Buyers echo the seller's
 * 402, so a match needs no request to the seller.
 */
export function sameListing(
  stored: DiscoveryResource,
  echoed: Omit<DiscoveryResource, "lastUpdated">,
): boolean {
  const text = (resource: Omit<DiscoveryResource, "lastUpdated">) => ({
    ...resource,
    accepts: [],
    lastUpdated: "",
  });
  if (!deepEqual(text(stored), text(echoed))) return false;
  return echoed.accepts.every((offer) => {
    const parsed = PaymentRequirementsV2Schema.safeParse(offer);
    return parsed.success && stored.accepts.some((kept) => deepEqual(kept, parsed.data));
  });
}
