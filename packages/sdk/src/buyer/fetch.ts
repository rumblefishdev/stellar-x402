import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
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

/**
 * The headers `new Request(input, init)` would send, read without building it: building it would
 * use up a request's body before upstream builds its own.
 */
function requestHeaders(input: Parameters<typeof fetch>[0], init?: RequestInit): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  return input instanceof Request ? input.headers : new Headers();
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
    // A payment header of the caller's own would read as this fetch's payment having left, and
    // upstream refuses it only after signing: refused here, before anything is counted.
    if (PAYMENT_HEADERS.some((name) => requestHeaders(input, init).has(name))) {
      throw new TypeError(
        "The request already carries a payment header (PAYMENT-SIGNATURE or X-PAYMENT); this " +
          "fetch makes the payment itself.",
      );
    }
    const call = startCall(config);
    // The caller's own signal, not a request's copy of it: upstream clones the request on its way,
    // and a clone's signal follows the original only loosely.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // True once the request carrying the signed payment has been handed to the fetch.
    let paymentSent = false;
    // What the underlying fetch, or the check before it, threw: it is not this library's to rename.
    let thrownBelow: { error: unknown } | undefined;

    const pay = wrapFetchWithPayment(async (request, requestInit) => {
      const outgoing = new Request(request, requestInit);
      try {
        if (outgoing.headers.has("PAYMENT-SIGNATURE")) {
          // Past the caller's deadline the request would be cut off before it connects: nothing
          // is sent, so the amount goes back and this is not a payment of unknown outcome.
          if (signal?.aborted) {
            await call.giveBack();
            throw signal.reason;
          }
          paymentSent = true;
        }
        return await baseFetch(outgoing);
      } catch (error) {
        thrownBelow = { error };
        throw error;
      }
    }, call.client);

    let response: Response;
    try {
      response = await pay(input, init);
    } catch (error) {
      if (paymentSent) {
        // The signed payment left this process; whether the seller settled it is unknown.
        throw new PaymentError(
          "payment_unknown",
          "The payment's outcome is unknown; it counts as spent.",
          { cause: error },
        );
      }
      if (thrownBelow?.error === error) throw error;
      const failure = call.failure();
      if (failure) throw failure;
      // wrapFetchWithPayment adds these prefixes when it cannot read the seller's 402 or finds no
      // offer the registered schemes can pay (a network, scheme or version not registered).
      if (
        error instanceof Error &&
        /^Failed to (parse payment requirements|create payment payload):/.test(error.message)
      ) {
        throw new PaymentError(
          "unsupported_payment",
          "The seller asks for a payment that cannot be made.",
          { cause: error.message },
        );
      }
      throw error;
    }

    const paid = call.paid();
    if (!paid) return response;

    let settle;
    // Why a `PAYMENT-RESPONSE` could not be read, for the cause of an answer without a settlement.
    let unreadable = "";
    try {
      settle = new x402HTTPClient(call.client).getPaymentSettleResponse((name) =>
        response.headers.get(name),
      );
    } catch (error) {
      if (response.headers.has("PAYMENT-RESPONSE")) unreadable = `, unreadable: ${String(error)}`;
      // A seller that answers 402 again without a settlement refused the payment before settling
      // it. Upstream has read and bounded a 402's body by now, so the copy is small.
      if (response.status === 402) {
        const body = await response
          .clone()
          .text()
          .catch(() => "");
        throw new PaymentError("payment_rejected", "The seller refused the payment.", {
          cause: body.slice(0, 500),
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
      throw new PaymentError(
        "payment_unknown",
        "The payment's outcome is unknown; it counts as spent.",
        { cause: `status ${response.status} without a settlement${unreadable}` },
      );
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
