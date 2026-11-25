import { LIMITS } from "@stellar-x402/bazaar";
import { createPayingFetch, PaymentError, type BudgetStore } from "@stellar-x402/sdk/buyer";
import { x402Client, x402HTTPClient, type SchemeRegistration } from "@x402/core/client";
import { z } from "zod";
import { checkUrl, guardedFetch, type SellerLimits } from "@stellar-x402/seller-fetch";
import { asToolError, ToolError } from "./results.js";
import { countDaily, refundDaily } from "./daily.js";

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

/** The daily database failed under the SDK's budget: told from a signing failure by this class. */
class DailyDatabaseError extends Error {}

/** The daily database could not be read or written, so how much is left today is unknown: pay nothing. */
function dailyDatabaseFailed(error: unknown): ToolError {
  return new ToolError(
    "payment_failed",
    "The daily budget database cannot be read or written, so nothing is paid.",
    String(error),
  );
}

/**
 * The SDK's budget store over the daily database (`daily.ts`), which every server process of the
 * buyer shares. The day's spending is read and the amount recorded in one transaction, so processes
 * paying at the same moment never pass the day together.
 */
function dailyBudget(dir: string, log: (message: string) => void): BudgetStore {
  return {
    count(entry, amount, daily) {
      try {
        return countDaily(dir, entry, amount, daily);
      } catch (error) {
        throw new DailyDatabaseError(String(error), { cause: error });
      }
    },
    giveBack(entry, amount) {
      try {
        refundDaily(dir, entry, amount);
      } catch (refundError) {
        // The amount stays counted for today: too strict, never too loose.
        log(
          `call_paid_http: could not give back ${amount} to the daily budget (${String(refundError)})`,
        );
      }
    },
  };
}

/**
 * The tool error for what the SDK's paying fetch threw, or `undefined` when it is not the SDK's: a
 * seller-fetch refusal before any payment passes through it unchanged. The code and the message
 * are the SDK's; what a seller or a library wrote (`cause`) goes to the log only.
 */
function paymentToolError(error: unknown, deadline: AbortSignal): ToolError | undefined {
  // A payment signed after the deadline is never sent: the SDK gives the amount back and throws
  // the deadline's own reason. A refusal, not a payment of unknown outcome.
  if (deadline.aborted && error === deadline.reason) {
    return new ToolError(
      "upstream_error",
      "The time limit passed before the payment was sent; nothing was sent.",
    );
  }
  if (!(error instanceof PaymentError)) return undefined;
  const { cause } = error;
  if (cause instanceof DailyDatabaseError) return dailyDatabaseFailed(cause.cause);
  if (cause === undefined) return new ToolError(error.code, error.message);
  const below = asToolError(cause);
  const detail =
    typeof cause === "string"
      ? cause
      : below
        ? `${below.code}: ${below.detail ?? below.message}`
        : String(cause);
  return new ToolError(error.code, error.message, detail);
}

export async function callPaidHttp(
  request: { url: string; method: string; headers?: Record<string, string>; body?: string },
  config: PaymentConfig,
  limits: SellerLimits,
  log: (message: string) => void,
): Promise<PaidResponse> {
  const url = checkUrl(request.url, limits.allowInsecureLocal);
  // A GET carries no body: fetch would throw, and the mistake is the agent's input, not the seller.
  if (request.method === "GET" && request.body !== undefined) {
    throw new ToolError("invalid_input", "A GET request cannot carry a body.");
  }

  // One deadline for the call's requests, the unpaid one and the paid retry. Signing is not cut off:
  // a signature that comes after the deadline is never sent, and the amount goes back.
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  // The limits, the daily budget and the payment itself are the SDK's (`@stellar-x402/sdk/buyer`),
  // over this server's guarded fetch and its daily database.
  const pay = createPayingFetch({
    schemes: config.schemes,
    payer: config.payer,
    assets: config.assets,
    budget: dailyBudget(config.dailyDir, log),
    now: config.now,
    fetch: guardedFetch(limits, deadline),
  });
  let response;
  try {
    response = await pay(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: deadline,
    });
  } catch (error) {
    throw paymentToolError(error, deadline) ?? error;
  }

  const body = await response.text();
  const contentType = response.headers.get("content-type")?.slice(0, LIMITS.mimeTypeChars) ?? null;
  const { payment } = response;
  if (!payment) {
    if (response.ok) return { status: response.status, contentType, body };
    if (response.status === 404) {
      throw new ToolError("resource_not_found", "The seller has no resource at this URL.");
    }
    throw new ToolError("upstream_error", `The seller answered ${response.status}.`);
  }
  if (payment.transaction === null) {
    // The answer is what was paid for; the log says why it carries no transaction.
    if (response.headers.has("PAYMENT-RESPONSE")) {
      try {
        new x402HTTPClient(new x402Client()).getPaymentSettleResponse((name) =>
          response.headers.get(name),
        );
      } catch (error) {
        log(`call_paid_http: ${url} sent a settlement that cannot be read (${String(error)})`);
      }
    }
    log(`call_paid_http: paid ${url} but the seller sent no settlement it could show`);
  }
  return { status: response.status, contentType, body, payment };
}
