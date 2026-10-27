import { LIMITS } from "@stellar-x402/bazaar";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";
import { z } from "zod";
import { checkBody, checkUrl, guardedFetch, type SellerLimits } from "@stellar-x402/seller-fetch";
import { ToolError } from "./results.js";

/** The get_resource tool's input and output, as server.ts registers it. */
export const GET_RESOURCE_INPUT = z
  .object({
    url: z
      .string()
      .describe("Resource URL with its query, e.g. https://api.example.com/x?city=Warsaw"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    body: z.string().optional().describe("JSON request body, for a price that depends on it"),
  })
  .strict();

export const GET_RESOURCE_OUTPUT = {
  status: z.number(),
  paymentRequired: z
    .record(z.unknown())
    .nullable()
    .describe("The seller's payment terms; null when the resource needs no payment"),
};

/**
 * What a seller asks for a resource, read from its 402 answer to an unpaid request: the payment terms
 * and the seller's own description of how to call it and what it returns. Nothing is signed. The
 * request is real: on a method and path the seller does not charge for, the seller runs it.
 */
export async function previewPayment(
  request: { url: string; method: string; body?: string },
  limits: SellerLimits,
): Promise<{ status: number; paymentRequired: PaymentRequired | null }> {
  const url = checkUrl(request.url, limits.allowInsecureLocal);
  checkBody(request.method, request.body);
  // A price can depend on the body (e.g. how many results are asked for), so the body is sent too.
  const headers = request.body === undefined ? undefined : { "content-type": "application/json" };
  const response = await guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))(url, {
    method: request.method,
    headers,
    body: request.body,
  });
  if (response.ok) return { status: response.status, paymentRequired: null };
  if (response.status === 404) {
    throw new ToolError("resource_not_found", "The seller has no resource at this URL.");
  }
  if (response.status !== 402) {
    throw new ToolError(
      "upstream_error",
      `The seller answered ${response.status} instead of its payment terms.`,
    );
  }
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
  } catch (error) {
    throw new ToolError(
      "unsupported_payment",
      "The seller's 402 carries no payment terms this server can read.",
      String(error),
    );
  }
  // Decoding checks the encoding only; the upstream schema checks the shape.
  const parsed = PaymentRequiredV2Schema.safeParse(paymentRequired);
  if (!parsed.success) {
    throw new ToolError(
      "unsupported_payment",
      "The seller's 402 carries no payment terms this server can read.",
      parsed.error.message,
    );
  }
  // The terms come in a header, which Node's HTTP client caps at 16 KiB: that bounds what reaches
  // the agent, the seller's input schema included.
  // The seller writes these; keep its free text short before it reaches the model.
  const { resource } = paymentRequired;
  return {
    status: response.status,
    paymentRequired: {
      ...paymentRequired,
      error: paymentRequired.error?.slice(0, LIMITS.descriptionChars),
      resource: {
        ...resource,
        description: resource.description?.slice(0, LIMITS.descriptionChars),
        mimeType: resource.mimeType?.slice(0, LIMITS.mimeTypeChars),
      },
    },
  };
}
