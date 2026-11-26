import { x402HTTPClient } from "@x402/core/client";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, readLimitedText } from "@x402/core/http";
import { checkConfig, startCall, type BuyerConfig } from "./call.js";
import { PaymentError } from "./errors.js";

export interface PayingFetchConfig extends BuyerConfig {
  /**
   * The fetch every request goes through, the unpaid one and the paid retry; the global one by
   * default. A caller that fetches URLs it did not choose passes a guarded one here.
   */
  fetch?: typeof fetch;
}

/** What was paid for an answer. */
export interface Payment {
  /**
   * The settlement's transaction hash. Null when the seller answered without a settlement it
   * could show: the answer is still what was paid for.
   */
  transaction: string | null;
  network: string;
  asset: string;
  /** Paid, in the asset's atomic units. */
  amount: string;
}

/** The seller's answer; `payment` is present when a payment was sent for it. */
export type PaidResponse = Response & { payment?: Payment };

/** The headers that carry a signed payment, in x402 v2 and v1. */
const PAYMENT_HEADERS = ["PAYMENT-SIGNATURE", "X-PAYMENT"];

/** No registered scheme can pay what the seller asks: its terms, or a network, scheme or version. */
function cannotPay(error: unknown): PaymentError {
  return new PaymentError(
    "unsupported_payment",
    "The seller asks for a payment that cannot be made.",
    { cause: String(error) },
  );
}

/** The signed payment left this process and whether the seller settled it is unknown. */
function outcomeUnknown(cause: unknown): PaymentError {
  return new PaymentError(
    "payment_unknown",
    "The payment's outcome is unknown; it counts as spent.",
    { cause },
  );
}

/**
 * A `fetch` that pays a seller's 402 within the config's limits and returns the seller's answer.
 * A payment that is refused or fails is a `PaymentError`; an answer without a payment, a 404 or a
 * 500 among them, is returned as it is, and a failure of the underlying fetch before any payment
 * was sent is thrown as it is. A request that already carries a payment header is a `TypeError`,
 * thrown before anything is counted.
 *
 * A request's `signal` is honored before the payment leaves: a payment signed after it aborted is
 * never sent, its amount goes back to the budget, and the signal's reason is thrown.
 */
export function createPayingFetch(
  config: PayingFetchConfig,
): (...args: Parameters<typeof fetch>) => Promise<PaidResponse> {
  checkConfig(config);
  const baseFetch = config.fetch ?? globalThis.fetch;

  return async (input, init) => {
    const request = new Request(input, init);
    // A payment header of the caller's own would be sent with the unpaid request and overwritten
    // on the paid one: refused here, before anything is counted.
    if (PAYMENT_HEADERS.some((name) => request.headers.has(name))) {
      throw new TypeError(
        "The request already carries a payment header (PAYMENT-SIGNATURE or X-PAYMENT); this " +
          "fetch makes the payment itself.",
      );
    }
    // The paid retry is this request again, so its body is kept before the first send uses it.
    const retry = request.clone();
    // The caller's own signal, not a request's copy of it: a clone's signal follows the original
    // only loosely.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const call = startCall(config);
    const http = new x402HTTPClient(call.client);

    // Nothing is signed yet: a failure of the fetch is the caller's to read, as it is.
    const unpaid = await baseFetch(request);
    if (unpaid.status !== 402) return unpaid;

    // A body too large to read is thrown as it is, as the fetch's other failures before paying.
    const text = await readLimitedText(unpaid, MAX_CONTROL_PLANE_RESPONSE_BYTES);
    let paymentRequired;
    try {
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // Not JSON: only an x402 v1 402 carries its terms in the body.
      }
      paymentRequired = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), body);
    } catch (error) {
      throw cannotPay(error);
    }

    let payload;
    try {
      payload = await http.createPaymentPayload(paymentRequired);
    } catch (error) {
      // A refusal of the limits, or signing failed (the amount went back in the failure hook);
      // otherwise no registered scheme can pay any offer: a network, scheme or version not ours.
      throw call.failure() ?? cannotPay(error);
    }
    // Set by the hook before signing, which ran: the payload was created.
    const paid = call.paid()!;
    let paymentHeaders;
    try {
      paymentHeaders = http.encodePaymentSignatureHeader(payload);
    } catch (error) {
      // Signed, never sent: an x402 version this library cannot put in a header.
      await call.giveBack();
      throw cannotPay(error);
    }
    for (const [name, value] of Object.entries(paymentHeaders)) retry.headers.set(name, value);
    retry.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");

    // Past the caller's deadline the request would be cut off before it connects: nothing is
    // sent, so the amount goes back and this is not a payment of unknown outcome.
    if (signal?.aborted) {
      await call.giveBack();
      throw signal.reason;
    }
    let response: Response;
    try {
      response = await baseFetch(retry);
    } catch (error) {
      throw outcomeUnknown(error);
    }

    // A 402 again is read now, within the same bound as the first, for the cause of a refusal.
    let refusedBody = "";
    if (response.status === 402) {
      try {
        refusedBody = await readLimitedText(response, MAX_CONTROL_PLANE_RESPONSE_BYTES);
      } catch (error) {
        throw outcomeUnknown(error);
      }
      response = new Response(refusedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    let settle;
    // Why a `PAYMENT-RESPONSE` could not be read, for the cause of an answer without a settlement.
    let unreadable = "";
    try {
      settle = http.getPaymentSettleResponse((name) => response.headers.get(name));
    } catch (error) {
      if (response.headers.has("PAYMENT-RESPONSE")) unreadable = `, unreadable: ${String(error)}`;
      // A seller that answers 402 again without a settlement refused the payment before settling it.
      if (response.status === 402) {
        throw new PaymentError("payment_rejected", "The seller refused the payment.", {
          cause: refusedBody.slice(0, 500),
        });
      }
    }
    if (settle && !settle.success) {
      throw new PaymentError("payment_rejected", "The seller's facilitator refused the payment.", {
        // Seller-written, so in the cause only: the message's ledger could be any number.
        cause: [settle.errorReason, settle.errorMessage].filter(Boolean).join(": "),
      });
    }
    // A Stellar transaction hash is 64 hex characters; anything else is not a settlement to show.
    const transaction =
      settle && /^[0-9a-f]{64}$/i.test(settle.transaction) ? settle.transaction : null;
    if (transaction === null && !response.ok) {
      throw outcomeUnknown(`status ${response.status} without a settlement${unreadable}`);
    }
    const payment: Payment = {
      transaction,
      network: paid.network,
      asset: paid.asset,
      amount: paid.amount.toString(),
    };
    return Object.assign(response, { payment });
  };
}
