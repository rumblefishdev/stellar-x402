import { canonicalizeUrl } from "@stellar-x402/bazaar";
import type { QuotedOffer } from "@stellar-x402/sdk/buyer";
import { z } from "zod";
import { PAY_NETWORK } from "./config.js";
import { ToolError } from "./results.js";

/**
 * The catalog listing an agent chose, as list_resources or search_resources returned it. Only the
 * fields the check reads are named; the rest of the item may come along and is ignored.
 */
export const LISTING = z
  .object({
    resource: z.string(),
    type: z.string().optional(),
    accepts: z
      .array(
        z
          .object({
            scheme: z.string(),
            network: z.string(),
            amount: z.string().regex(/^[0-9]+$/, "a whole number of atomic units"),
            asset: z.string(),
            payTo: z.string(),
          })
          .passthrough(),
      )
      .min(1),
    input: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .describe(
    "The list_resources or search_resources item this call is for, as it came. With it, a " +
      "seller asking more than its price or naming another payTo is refused before signing.",
  );

export type Listing = z.infer<typeof LISTING>;

/**
 * A path segment of a listing's route template: exactly `:`, as `eraseParamNames` leaves a
 * parameter (ADR 0008). Any other segment, one like `:x` in a concrete path too, matches itself.
 */
function segmentMatches(listed: string, called: string): boolean {
  return listed === ":" ? called !== "" : listed === called;
}

/**
 * A URL as the catalog keys it: canonical, without the query or the fragment. They are dropped
 * before the URL is canonicalized, whose length limit is the catalog's for a resource, so a long
 * query is not mistaken for another URL.
 */
function resourceOf(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  url.search = "";
  url.hash = "";
  const canonical = canonicalizeUrl(url.href, "http");
  return canonical === undefined ? undefined : new URL(canonical);
}

/** Whether a called URL is the listing's resource; a `:` segment of a template takes any one. */
function sameResource(listed: URL, called: URL): boolean {
  if (listed.origin !== called.origin) return false;
  const wanted = listed.pathname.split("/");
  const actual = called.pathname.split("/");
  return (
    wanted.length === actual.length &&
    wanted.every((segment, i) => segmentMatches(segment, actual[i]!))
  );
}

/**
 * The listing's offers, the terms the payment is held to, once the listing is checked to be for
 * this call: an `http` listing of this URL and method, on the network this server pays on. A
 * listing for another call would let any listing's price stand in for the seller's, so it is
 * refused, and so is one without its type or method: the catalog's items always carry both, and
 * without the method a listing for one method could vouch for another's price (ADR 0008 keys it).
 */
export function quotedOffers(listing: Listing, url: string, method: string): QuotedOffer[] {
  if (listing.type === undefined) {
    throw new ToolError("invalid_input", "The listing has no type: pass the item as it came.");
  }
  if (listing.type !== "http") {
    throw new ToolError("invalid_input", "The listing is not an HTTP resource.");
  }
  const called = resourceOf(url);
  if (!called) {
    throw new ToolError(
      "invalid_input",
      "The called URL is not one the catalog can list (such as one with a path too long, a " +
        "user name, an empty path segment or a host ending in a dot), so no listing can be for it.",
    );
  }
  const listed = resourceOf(listing.resource);
  if (!listed || !sameResource(listed, called)) {
    throw new ToolError("invalid_input", "The listing is for another URL than the one called.");
  }
  const listedMethod = listing.input?.method;
  if (typeof listedMethod !== "string") {
    throw new ToolError(
      "invalid_input",
      "The listing names no HTTP method in input.method, so it cannot be held to this call: " +
        "pass the item as it came. A catalog item without one cannot be checked.",
    );
  }
  if (listedMethod.toUpperCase() !== method) {
    throw new ToolError("invalid_input", "The listing is for another HTTP method.");
  }
  // search_resources gives both networks' listings of a URL; one for another network says nothing
  // about this one's terms, and refusing the seller for it would blame the seller for the choice.
  if (!listing.accepts.some((offer) => offer.network === PAY_NETWORK)) {
    throw new ToolError(
      "invalid_input",
      `The listing is for another network: this server pays on ${PAY_NETWORK}, so choose that ` +
        "network's listing.",
    );
  }
  return listing.accepts.map(({ scheme, network, asset, payTo, amount }) => ({
    scheme,
    network,
    asset,
    payTo,
    amount,
  }));
}
