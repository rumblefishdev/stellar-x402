import { SellerFetchError, guardedFetch, type SellerLimits } from "@stellar-x402/seller-fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";

/** Why a seller gave no usable answer; `detail` is for logs and the attempt's row only. */
export type SellerAnswer =
  | { ok: true; paymentRequired: PaymentRequired }
  | {
      ok: false;
      reason: SellerFetchError["code"] | "not_402" | "unreadable_402";
      detail?: string;
    };

/**
 * Asks the seller for its listing with one unpaid request (0063) and reads its 402 terms as the
 * buyer's MCP server does (`packages/mcp` preview). The request goes through the seller-fetch
 * guard: public addresses only, no redirects, a deadline and a body cap.
 */
export async function askSeller(
  request: { url: string; method: string; body?: string },
  limits: SellerLimits,
): Promise<SellerAnswer> {
  let response: Response;
  try {
    response = await guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))(request.url, {
      method: request.method,
      headers: request.body === undefined ? undefined : { "content-type": "application/json" },
      body: request.body,
    });
  } catch (error) {
    if (error instanceof SellerFetchError) {
      return { ok: false, reason: error.code, detail: error.detail ?? error.message };
    }
    throw error;
  }
  if (response.status !== 402) {
    return { ok: false, reason: "not_402", detail: `status ${response.status}` };
  }
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
  } catch (error) {
    return { ok: false, reason: "unreadable_402", detail: String(error) };
  }
  // Decoding checks the encoding only; the upstream schema checks the shape.
  const parsed = PaymentRequiredV2Schema.safeParse(paymentRequired);
  if (!parsed.success) return { ok: false, reason: "unreadable_402", detail: parsed.error.message };
  return { ok: true, paymentRequired };
}
