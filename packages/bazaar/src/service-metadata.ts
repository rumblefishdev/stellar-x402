import {
  PaymentPayloadV2Schema as UpstreamPaymentPayloadV2Schema,
  PaymentRequiredV2Schema as UpstreamPaymentRequiredV2Schema,
  ResourceInfoSchema,
} from "@x402/core/schemas";
import { z } from "zod";

/**
 * Upstream's 402 and payment schemas with `serviceName`, `tags` and `iconUrl` typed only. Upstream
 * (`@x402/core` 2.28.0) refuses the whole 402 or payment when one of them breaks a Bazaar limit,
 * such as 6 tags, while the Bazaar spec drops only that field (`bazaar.md:380-391`) and the
 * listing's validator does so. Every other rule is upstream's. Lore 0130: delete with the bump to
 * the release that carries the upstream fix.
 */
const resource = ResourceInfoSchema.extend({
  serviceName: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  tags: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? undefined),
  iconUrl: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

export const PaymentRequiredV2Schema = UpstreamPaymentRequiredV2Schema.extend({ resource });

export const PaymentPayloadV2Schema = UpstreamPaymentPayloadV2Schema.extend({
  resource: resource.nullish().transform((v) => v ?? undefined),
});
