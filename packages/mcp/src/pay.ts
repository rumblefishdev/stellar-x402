import { LIMITS } from "@stellar-x402/bazaar";
import { x402Client, x402HTTPClient, type SchemeRegistration } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ToolError } from "./results.js";
import { checkUrl, guardedFetch, type SellerLimits } from "./seller.js";

export interface PaymentConfig {
  /** Scheme clients holding the buyer's key; the CLI registers `ExactStellarScheme` for testnet only. */
  schemes: SchemeRegistration[];
  /** Per asset contract: the largest price one call may pay and the budget for this process, in atomic units. */
  assets: Record<string, { maxPerCall: bigint; budget: bigint }>;
}

export interface PaidResponse {
  status: number;
  contentType: string | null;
  body: string;
  /**
   * Present when a payment was sent. `transaction` is null when the seller answered without a
   * settlement it could show: the response is still what was paid for.
   */
  payment?: { transaction: string | null; network: string; asset: string; amount: string };
}

/** What every call has paid so far, per asset; shared by all calls of one process. */
export type Spent = Map<string, bigint>;

export async function callPaidHttp(
  request: { url: string; method: string; headers?: Record<string, string>; body?: string },
  config: PaymentConfig,
  spent: Spent,
  limits: SellerLimits,
): Promise<PaidResponse> {
  const url = checkUrl(request.url, limits.allowInsecureLocal);

  // One client per call, so its hooks know which payment is this call's.
  const client = x402Client.fromConfig({ schemes: config.schemes, spendControls: false });
  let refusal: ToolError | undefined;
  let paid: { network: string; asset: string; amount: bigint } | undefined;
  let signingError: Error | undefined;

  // Of the seller's offers, keep those in an allowed asset and within the per-call limit; the library
  // pays the first one left.
  client.registerPolicy((_version, offers) => {
    const allowed = offers.filter((offer) => config.assets[offer.asset]);
    const affordable = allowed.filter(
      (offer) => BigInt(offer.amount) <= config.assets[offer.asset]!.maxPerCall,
    );
    if (allowed.length === 0) {
      refusal = new ToolError("asset_not_allowed", "The seller asks for an asset not allowed.");
    } else if (affordable.length === 0) {
      refusal = new ToolError("over_price_limit", "The price is over the per-call limit.");
    }
    return affordable;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    const amount = BigInt(offer.amount);
    const already = spent.get(offer.asset) ?? 0n;
    if (already + amount > config.assets[offer.asset]!.budget) {
      refusal = new ToolError("over_budget", "The payment would exceed the budget.");
      return { abort: true, reason: refusal.code };
    }
    // Counted as spent now, in the same synchronous step as the check, so two calls at once cannot
    // both pass. Once signed it is never given back, so a seller cannot return it to the budget by
    // claiming the payment failed.
    spent.set(offer.asset, already + amount);
    paid = { network: offer.network, asset: offer.asset, amount };
  });
  // Nothing was sent: signing failed (an unfunded payer fails here, in simulation), so the amount
  // goes back to the budget.
  client.onPaymentCreationFailure(async ({ error }) => {
    signingError = error;
    if (paid) spent.set(paid.asset, (spent.get(paid.asset) ?? 0n) - paid.amount);
  });

  const pay = wrapFetchWithPayment(guardedFetch(limits.maxResponseBytes, limits.timeoutMs), client);
  let response: Response;
  try {
    response = await pay(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    if (paid && !signingError) {
      // The signed payment left this process; whether the seller settled it is unknown.
      const detail =
        error instanceof ToolError
          ? `${error.code}: ${error.detail ?? error.message}`
          : String(error);
      throw new ToolError(
        "payment_unknown",
        "The payment's outcome is unknown; it counts as spent.",
        detail,
      );
    }
    if (error instanceof ToolError) throw error;
    if (refusal) throw refusal;
    if (signingError) {
      // The payer's simulation fails in the asset contract: #10 is a balance too low, #13 a missing
      // trustline (measured on testnet: `HostError: Error(Contract, #13)` for an account without USDC).
      if (/Error\(Contract, #(10|13)\)/.test(String(signingError))) {
        throw new ToolError(
          "insufficient_funds",
          "The payer does not hold enough of the asset.",
          String(signingError),
        );
      }
      throw new ToolError(
        "payment_failed",
        "The payment could not be created.",
        String(signingError),
      );
    }
    // The seller's 402 named no network, scheme or price this server can pay with.
    throw new ToolError(
      "unsupported_payment",
      "The seller asks for a payment this server cannot make.",
      String(error),
    );
  }

  const body = await response.text();
  const contentType = response.headers.get("content-type")?.slice(0, LIMITS.mimeTypeChars) ?? null;
  if (!paid) {
    if (response.ok) return { status: response.status, contentType, body };
    if (response.status === 404) {
      throw new ToolError("resource_not_found", "The seller has no resource at this URL.");
    }
    throw new ToolError("upstream_error", `The seller answered ${response.status}.`);
  }
  let settle;
  try {
    settle = new x402HTTPClient(client).getPaymentSettleResponse((name) =>
      response.headers.get(name),
    );
  } catch {
    // A seller that answers 402 again without a settlement refused the payment before settling it.
    if (response.status === 402) {
      throw new ToolError(
        "payment_rejected",
        "The seller refused the payment.",
        body.slice(0, 500),
      );
    }
  }
  if (settle && !settle.success) {
    throw new ToolError(
      "payment_rejected",
      "The seller's facilitator refused the payment.",
      settle.errorReason,
    );
  }
  // A Stellar transaction hash is 64 hex characters; anything else is not a settlement we can show.
  const transaction =
    settle && /^[0-9a-f]{64}$/i.test(settle.transaction) ? settle.transaction : null;
  if (transaction === null && !response.ok) {
    throw new ToolError(
      "payment_unknown",
      "The payment's outcome is unknown; it counts as spent.",
      `status ${response.status} without a settlement`,
    );
  }
  return {
    status: response.status,
    contentType,
    body,
    payment: {
      transaction,
      network: paid.network,
      asset: paid.asset,
      amount: paid.amount.toString(),
    },
  };
}
