import {
  PaymentPayloadV2Schema as UpstreamPaymentPayloadV2Schema,
  PaymentRequiredV2Schema as UpstreamPaymentRequiredV2Schema,
  ResourceInfoSchema,
} from "@x402/core/schemas";
import { z } from "zod";

/**
 * Upstream's 402 and payment schemas with `serviceName`, `tags` and `iconUrl` typed only: the Bazaar
 * spec drops a field that breaks its limit (`bazaar.md:380-391`), upstream (2.28.0 to 2.31.0)
 * refuses the whole object. Lore 0130: delete with the bump to the release that carries the upstream
 * fix. This package's `zod` is the major `@x402/core` builds its schemas with (4 from 2.31.0): a field
 * of another major in their `extend` throws on every parse (0145).
 */
const resource = ResourceInfoSchema.extend({
  serviceName: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  iconUrl: z.string().nullish(),
});

export const PaymentRequiredV2Schema = UpstreamPaymentRequiredV2Schema.extend({ resource });

export const PaymentPayloadV2Schema = UpstreamPaymentPayloadV2Schema.extend({
  resource: resource.nullish(),
});
