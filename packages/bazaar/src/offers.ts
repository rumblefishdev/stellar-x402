import { PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { PaymentRequirements } from "@x402/core/types";
import { LIMITS } from "./limits.js";

export type OffersResult =
  | { ok: true; offers: PaymentRequirements[]; droppedFields: number }
  | {
      ok: false;
      reason: "other_pay_to" | "invalid_offer" | "too_large";
      detail?: string;
      bytes?: number;
    };

/**
 * The seller's offers a listing keeps (0063): only those to the listing key's network and `payTo`,
 * each cut to the spec's seven fields by the upstream schema, at most `LIMITS.offers` of them; their
 * `extra` counts only toward the whole listing's cap. One over a limit refuses the whole listing, so a seller
 * sees why rather than a listing missing an offer. `droppedFields` counts the fields the schema cut.
 */
export function sellerOffers(
  accepts: readonly unknown[],
  key: { network: string; payTo: string },
): OffersResult {
  const ours = accepts.filter(
    (offer): offer is Record<string, unknown> =>
      typeof offer === "object" &&
      offer !== null &&
      (offer as Record<string, unknown>).network === key.network &&
      (offer as Record<string, unknown>).payTo === key.payTo,
  );
  if (ours.length === 0) return { ok: false, reason: "other_pay_to" };
  if (ours.length > LIMITS.offers) return { ok: false, reason: "too_large", detail: "accepts" };
  const offers: PaymentRequirements[] = [];
  let droppedFields = 0;
  for (const raw of ours) {
    const parsed = PaymentRequirementsV2Schema.safeParse(raw);
    if (!parsed.success)
      return { ok: false, reason: "invalid_offer", detail: parsed.error.message };
    droppedFields += Object.keys(raw).length - Object.keys(parsed.data).length;
    offers.push(parsed.data as PaymentRequirements);
  }
  return { ok: true, offers, droppedFields };
}
