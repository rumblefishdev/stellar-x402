/**
 * What the facilitator answered about a route's Bazaar listing, read from a settlement.
 *
 * - `processing`: the listing passed the facilitator's check and was taken for cataloging. Whether
 *   the route was then cataloged isn't sent back: cataloging runs after the settlement's answer and
 *   can still leave it out.
 * - `rejected`: the listing was refused, with the facilitator's `reason`, such as `invalid_info`,
 *   `schema_too_complex` or `resource_not_public`. The payment settles either way.
 * - `none`: no answer about a listing, from a route that declares none or a facilitator without the
 *   Bazaar.
 */
export type CatalogAnswer =
  { status: "processing" } | { status: "rejected"; reason: string } | { status: "none" };

/** A reason as the facilitator writes them; anything else is not passed on. */
const REASON = /^[a-z_]{1,40}$/;

/**
 * The catalog's answer in a settlement, such as the `result` an `onAfterSettle` hook gets:
 *
 * ```ts
 * resourceServer.onAfterSettle(async ({ result }) => {
 *   const answer = readCatalogAnswer(result);
 *   if (answer.status === "rejected") console.warn(`not listed: ${answer.reason}`);
 * });
 * ```
 */
export function readCatalogAnswer(result: {
  extensionResponses?: Record<string, unknown>;
}): CatalogAnswer {
  const bazaar = result.extensionResponses?.bazaar;
  if (typeof bazaar !== "object" || bazaar === null) return { status: "none" };
  const { status, rejectedReason } = bazaar as { status?: unknown; rejectedReason?: unknown };
  if (status === "processing") return { status: "processing" };
  if (status === "rejected") {
    const reason =
      typeof rejectedReason === "string" && REASON.test(rejectedReason)
        ? rejectedReason
        : "unknown";
    return { status: "rejected", reason };
  }
  return { status: "none" };
}
