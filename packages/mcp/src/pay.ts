import { LIMITS } from "@stellar-x402/bazaar";
import { x402Client, x402HTTPClient, type SchemeRegistration } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ToolError } from "./results.js";
import { checkBody, checkUrl, guardedFetch, type SellerLimits } from "./guard.js";
import { countDaily, refundDaily, spentOn, utcDay } from "./daily.js";

export interface PaymentConfig {
  /** Scheme clients holding the buyer's key; the CLI registers `ExactStellarScheme` for testnet only. */
  schemes: SchemeRegistration[];
  /**
   * Per asset contract, in atomic units: the largest price one call may pay, the budget for this
   * process and, optionally, the budget for one UTC day shared by every process using `dailyFile`.
   */
  assets: Record<string, { maxPerCall: bigint; budget: bigint; daily?: bigint }>;
  /** The file that records what was spent per day; required when an asset has a `daily` budget. */
  dailyFile?: string;
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

/** What every call has paid so far, per asset; shared by all calls of one process. */
export type Spent = Map<string, bigint>;

/** The daily record could not be read or written, so how much is left today is unknown: pay nothing. */
function dailyUnreadable(error: unknown): ToolError {
  return new ToolError(
    "payment_failed",
    "The daily budget record cannot be read, so nothing is paid.",
    String(error),
  );
}

export async function callPaidHttp(
  request: { url: string; method: string; headers?: Record<string, string>; body?: string },
  config: PaymentConfig,
  spent: Spent,
  limits: SellerLimits,
  log: (message: string) => void,
): Promise<PaidResponse> {
  const url = checkUrl(request.url, limits.allowInsecureLocal);
  checkBody(request.method, request.body);

  // One client per call, so its hooks know which payment is this call's.
  const client = x402Client.fromConfig({ schemes: config.schemes, spendControls: false });
  let refusal: ToolError | undefined;
  let paid: { network: string; asset: string; amount: bigint } | undefined;
  let signingError: Error | undefined;
  /** The day this call's amount was counted against in the daily record, so a refund finds it. */
  let countedDay: string | undefined;
  const now = config.now ?? (() => new Date());

  // Of the seller's offers, keep those in an allowed asset, with a short enough authorization, within
  // the per-call limit and the remaining budgets; the library pays the first one left.
  client.registerPolicy((_version, offers) => {
    const allowed = offers.filter((offer) => Object.hasOwn(config.assets, offer.asset));
    const shortLived = allowed.filter(
      (offer) => offer.maxTimeoutSeconds <= MAX_AUTHORIZATION_SECONDS,
    );
    const affordable = shortLived.filter(
      (offer) => BigInt(offer.amount) <= config.assets[offer.asset]!.maxPerCall,
    );
    const inBudget = affordable.filter(
      (offer) =>
        (spent.get(offer.asset) ?? 0n) + BigInt(offer.amount) <= config.assets[offer.asset]!.budget,
    );
    let today = new Map<string, bigint>();
    if (inBudget.some((offer) => config.assets[offer.asset]!.daily !== undefined)) {
      try {
        today = spentOn(config.dailyFile!, utcDay(now()));
      } catch (error) {
        refusal = dailyUnreadable(error);
        return [];
      }
    }
    const inDaily = inBudget.filter((offer) => {
      const daily = config.assets[offer.asset]!.daily;
      return daily === undefined || (today.get(offer.asset) ?? 0n) + BigInt(offer.amount) <= daily;
    });
    if (allowed.length === 0) {
      refusal = new ToolError("asset_not_allowed", "The seller asks for an asset not allowed.");
    } else if (shortLived.length === 0) {
      refusal = new ToolError(
        "unsupported_payment",
        `The seller wants the payment valid for more than ${MAX_AUTHORIZATION_SECONDS} s.`,
      );
    } else if (affordable.length === 0) {
      refusal = new ToolError("over_price_limit", "The price is over the per-call limit.");
    } else if (inBudget.length === 0) {
      refusal = new ToolError("over_budget", "The payment would exceed the budget.");
    } else if (inDaily.length === 0) {
      refusal = new ToolError("over_budget", "The payment would exceed the daily budget.");
    }
    return inDaily;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    const amount = BigInt(offer.amount);
    const limits = config.assets[offer.asset]!;
    const already = spent.get(offer.asset) ?? 0n;
    if (already + amount > limits.budget) {
      refusal = new ToolError("over_budget", "The payment would exceed the budget.");
      return { abort: true, reason: refusal.code };
    }
    // The policy already kept offers within the budget, and today it runs in the same synchronous
    // step as this hook; the check stays here, where the amount is counted, so two calls at once
    // cannot both pass even if the library puts an await in between. Once signed it is never given
    // back, so a seller cannot return it to the budget by claiming the payment failed.
    spent.set(offer.asset, already + amount);
    if (limits.daily !== undefined) {
      // Counted under the file's lock, so other processes paying at once see this amount.
      const day = utcDay(now());
      let counted = false;
      try {
        counted = await countDaily(config.dailyFile!, day, offer.asset, amount, limits.daily);
      } catch (error) {
        refusal = dailyUnreadable(error);
      }
      if (!counted) {
        // Nothing is signed, so the process budget gets the amount back.
        spent.set(offer.asset, (spent.get(offer.asset) ?? 0n) - amount);
        refusal ??= new ToolError("over_budget", "The payment would exceed the daily budget.");
        return { abort: true, reason: refusal.code };
      }
      countedDay = day;
    }
    paid = { network: offer.network, asset: offer.asset, amount };
  });
  // Nothing was sent: signing failed (an unfunded payer fails here, in simulation), so the amount
  // goes back to the budgets.
  client.onPaymentCreationFailure(async ({ error }) => {
    signingError = error;
    if (!paid) return;
    spent.set(paid.asset, (spent.get(paid.asset) ?? 0n) - paid.amount);
    if (countedDay === undefined) return;
    try {
      await refundDaily(config.dailyFile!, countedDay, paid.asset, paid.amount);
    } catch (refundError) {
      // The amount stays counted for today: too strict, never too loose.
      log(
        `call_paid_http: could not give back ${paid.amount} to the daily budget (${String(refundError)})`,
      );
    }
  });

  const pay = wrapFetchWithPayment(guardedFetch(limits), client);
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
