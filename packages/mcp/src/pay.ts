import { LIMITS } from "@stellar-x402/bazaar";
import { x402Client, x402HTTPClient, type SchemeRegistration } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { z } from "zod";
import { ToolError } from "./results.js";
import { checkBody, checkUrl, guardedFetch, type SellerLimits } from "./guard.js";
import { countDaily, refundDaily, utcDay, type DailyEntry } from "./daily.js";

/** The call_paid_http tool's input and output, as server.ts registers it. */
export const CALL_PAID_HTTP_INPUT = z
  .object({
    url: z
      .string()
      .describe("Resource URL with its query, e.g. https://api.example.com/x?city=Warsaw"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    body: z.string().optional().describe("JSON request body"),
  })
  .strict();

export const CALL_PAID_HTTP_OUTPUT = {
  status: z.number(),
  contentType: z.string().nullable(),
  body: z.string(),
  payment: z
    .object({
      transaction: z
        .string()
        .nullable()
        .describe("Null when the seller sent no settlement it could show"),
      network: z.string(),
      asset: z.string(),
      amount: z.string().describe("Paid, in the asset's smallest unit"),
    })
    .optional(),
};

export interface PaymentConfig {
  /** Scheme clients holding the buyer's key; the CLI registers `ExactStellarScheme` for testnet only. */
  schemes: SchemeRegistration[];
  /** The buyer's public address, the address those schemes sign for; it keys the daily record. */
  payer: string;
  /**
   * Per asset contract, in atomic units: the largest price one call may pay and the budget for one
   * UTC day, shared by every process using `dailyDir`.
   */
  assets: Record<string, { maxPerCall: bigint; daily: bigint }>;
  /** The directory holding `spent.sqlite`, the database of what was spent per day. */
  dailyDir: string;
  /** The clock that decides the day; tests set it, the server uses the system's. */
  now?: () => Date;
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

/**
 * The longest a seller may keep our signed payment valid: 300 s is the `@x402/express` default (seen in
 * the 402 of examples/http-api). A longer one could be settled long after the agent got its answer.
 */
const MAX_AUTHORIZATION_SECONDS = 300;

/** The daily database could not be read or written, so how much is left today is unknown: pay nothing. */
function dailyDatabaseFailed(error: unknown): ToolError {
  return new ToolError(
    "payment_failed",
    "The daily budget database cannot be read or written, so nothing is paid.",
    String(error),
  );
}

export async function callPaidHttp(
  request: { url: string; method: string; headers?: Record<string, string>; body?: string },
  config: PaymentConfig,
  limits: SellerLimits,
  log: (message: string) => void,
): Promise<PaidResponse> {
  const url = checkUrl(request.url, limits.allowInsecureLocal);
  checkBody(request.method, request.body);

  // One deadline for the call's requests, the unpaid one and the paid retry. Signing is not cut off:
  // a signature that comes after the deadline is never sent, and the amount goes back.
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  // One client per call, so its hooks know which payment is this call's.
  const client = x402Client.fromConfig({ schemes: config.schemes, spendControls: false });
  let refusal: ToolError | undefined;
  /** `countedIn` is where the amount was counted in the daily record, so a refund finds it. */
  let paid: { network: string; asset: string; amount: bigint; countedIn: DailyEntry } | undefined;
  let signingError: Error | undefined;
  const now = config.now ?? (() => new Date());
  // True once the request carrying the signed payment has been handed to the network.
  let paymentSent = false;
  // Nothing was sent, so the amount goes back to the day it was counted on.
  const giveBack = () => {
    if (!paid) return;
    try {
      refundDaily(config.dailyDir, paid.countedIn, paid.amount);
    } catch (refundError) {
      // The amount stays counted for today: too strict, never too loose.
      log(
        `call_paid_http: could not give back ${paid.amount} to the daily budget (${String(refundError)})`,
      );
    }
  };

  // Of the seller's offers, keep those in an allowed asset, at a price above zero, with a short enough
  // authorization and within the per-call limit; the library pays the first one left, and the daily
  // budget is counted when it is chosen.
  client.registerPolicy((_version, offers) => {
    const allowed = offers.filter((offer) => Object.hasOwn(config.assets, offer.asset));
    // A zero or negative price would be counted before the library refuses to sign it, and a negative
    // count raises the day's budget for every process until it is given back.
    const priced = allowed.filter((offer) => /^[1-9][0-9]*$/.test(offer.amount));
    const shortLived = priced.filter(
      (offer) => offer.maxTimeoutSeconds <= MAX_AUTHORIZATION_SECONDS,
    );
    const affordable = shortLived.filter(
      (offer) => BigInt(offer.amount) <= config.assets[offer.asset]!.maxPerCall,
    );
    if (allowed.length === 0) {
      refusal = new ToolError("asset_not_allowed", "The seller asks for an asset not allowed.");
    } else if (priced.length === 0) {
      refusal = new ToolError(
        "unsupported_payment",
        "The seller's price is not a whole number of atomic units above zero.",
      );
    } else if (shortLived.length === 0) {
      refusal = new ToolError(
        "unsupported_payment",
        `The seller wants the payment valid for more than ${MAX_AUTHORIZATION_SECONDS} s.`,
      );
    } else if (affordable.length === 0) {
      refusal = new ToolError("over_price_limit", "The price is over the per-call limit.");
    }
    return affordable;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    const amount = BigInt(offer.amount);
    // The day's spending is read and the amount recorded in one transaction, so processes paying at
    // the same moment never pass the day together. Once signed the amount is never given back,
    // so a seller cannot return it to the budget by claiming the payment failed.
    const countedIn = { day: utcDay(now()), payer: config.payer, asset: offer.asset };
    let counted = false;
    try {
      counted = countDaily(config.dailyDir, countedIn, amount, config.assets[offer.asset]!.daily);
    } catch (error) {
      refusal = dailyDatabaseFailed(error);
    }
    if (!counted) {
      refusal ??= new ToolError("over_budget", "The payment would exceed the daily budget.");
      return { abort: true, reason: refusal.code };
    }
    paid = { network: offer.network, asset: offer.asset, amount, countedIn };
  });
  // Nothing was sent: signing failed (an unfunded payer fails here, in simulation), so the amount
  // goes back to the budget.
  client.onPaymentCreationFailure(async ({ error }) => {
    signingError = error;
    giveBack();
  });

  const sellerFetch = guardedFetch(limits, deadline);
  const pay = wrapFetchWithPayment(async (input, init) => {
    const outgoing = new Request(input, init);
    if (outgoing.headers.has("PAYMENT-SIGNATURE")) {
      // Past the deadline the request would be refused before it connects: nothing is sent, so this
      // is a refusal with the amount given back, not a payment of unknown outcome.
      if (deadline.aborted) {
        giveBack();
        throw new ToolError(
          "upstream_error",
          "The time limit passed before the payment was sent; nothing was sent.",
        );
      }
      paymentSent = true;
    }
    return sellerFetch(outgoing);
  }, client);
  let response: Response;
  try {
    response = await pay(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    if (paymentSent) {
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
      // trustline (both measured on testnet: `#13` for an account without a USDC trustline, `#10` for one
      // with a trustline and no USDC).
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
    // wrapFetchWithPayment adds these prefixes when it cannot read the seller's 402 or finds no offer
    // this server can pay with (an unregistered network, scheme or version). Anything else is a bug.
    if (
      error instanceof Error &&
      /^Failed to (parse payment requirements|create payment payload):/.test(error.message)
    ) {
      throw new ToolError(
        "unsupported_payment",
        "The seller asks for a payment this server cannot make.",
        error.message,
      );
    }
    throw error;
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
  } catch (error) {
    if (response.headers.has("PAYMENT-RESPONSE")) {
      log(`call_paid_http: ${url} sent a settlement that cannot be read (${String(error)})`);
    }
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
  if (transaction === null && response.ok) {
    log(`call_paid_http: paid ${url} but the seller sent no settlement it could show`);
  }
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
