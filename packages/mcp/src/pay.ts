import { BlockList, isIP } from "node:net";
import { LIMITS } from "@stellar-x402/bazaar";
import { x402Client, x402HTTPClient, type SchemeRegistration } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";

export interface PaymentConfig {
  /** Scheme clients holding the buyer's key; the CLI registers `ExactStellarScheme` for testnet only. */
  schemes: SchemeRegistration[];
  /** Per asset contract: the largest price one call may pay and the budget for this process, in atomic units. */
  assets: Record<string, { maxPerCall: bigint; budget: bigint }>;
  /** Refuse a seller response body larger than this. */
  maxResponseBytes: number;
  /** Allow `http` and loopback or private hosts: only for a seller run locally in tests. */
  allowInsecureLocal?: boolean;
}

export type PaymentErrorCode =
  | "unsafe_url"
  | "unsupported_payment"
  | "asset_not_allowed"
  | "over_price_limit"
  | "over_budget"
  | "insufficient_funds"
  | "payment_failed"
  | "payment_rejected"
  | "payment_unknown"
  | "response_too_large"
  | "upstream_error";

/**
 * A failure with its code. `message` is safe to show the agent; `detail` (a library or seller error)
 * goes only to the server log.
 */
export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface PaidResponse {
  status: number;
  contentType: string | null;
  body: string;
  /** Present when a payment was made and settled. */
  payment?: { transaction: string; network: string; asset: string; amount: string };
}

/** What every call has paid so far, per asset; shared by all calls of one process. */
export type Spent = Map<string, bigint>;

/**
 * Loopback, private, link-local, carrier-grade NAT and unspecified ranges: a URL naming one of these
 * would make the buyer's machine call into its own network.
 */
const PRIVATE = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE.addSubnet(address, prefix, "ipv4");
}
// IPv4-mapped (`::ffff:a.b.c.d`) addresses are matched against the IPv4 rules by `BlockList` itself;
// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address that could be private.
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["64:ff9b::", 96],
  ["2002::", 16],
] as const) {
  PRIVATE.addSubnet(address, prefix, "ipv6");
}

/**
 * https only, and no local host named in the URL. A name that resolves to a private address is not
 * looked up: a device on the buyer's network cannot present a certificate for a public name.
 */
function checkUrl(raw: string, allowInsecureLocal: boolean): URL {
  if (!URL.canParse(raw)) throw new PaymentError("unsafe_url", "url is not a URL.");
  const url = new URL(raw);
  if (allowInsecureLocal) return url;
  if (url.protocol !== "https:")
    throw new PaymentError("unsafe_url", "Only https URLs are called.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (family !== 0 && PRIVATE.check(host, family === 6 ? "ipv6" : "ipv4"));
  if (local)
    throw new PaymentError("unsafe_url", "The URL points at a loopback or private address.");
  return url;
}

/**
 * The fetch the payment wrapper uses: no redirects (the paid retry carries the signed payment, which
 * must not reach another host), a timeout, and a body size cap counted while the body arrives.
 */
function guardedFetch(maxResponseBytes: number, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetch(new Request(input, init), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PaymentError("upstream_error", "The request to the seller failed.", String(error));
    }
    if (response.status >= 300 && response.status < 400) {
      throw new PaymentError(
        "unsafe_url",
        "The seller answered with a redirect, which is not followed.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > maxResponseBytes) {
        throw new PaymentError("response_too_large", "The seller's response is too large.");
      }
      chunks.push(chunk);
    }
    // A 204 or 304 must not be given a body, not even an empty one.
    const body = size === 0 ? null : Buffer.concat(chunks);
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

export async function callPaidHttp(
  request: { url: string; method: string; headers?: Record<string, string>; body?: string },
  config: PaymentConfig,
  spent: Spent,
  timeoutMs: number,
): Promise<PaidResponse> {
  const url = checkUrl(request.url, config.allowInsecureLocal ?? false);

  // One client per call, so its hooks know which payment is this call's.
  const client = x402Client.fromConfig({ schemes: config.schemes, spendControls: false });
  let refusal: PaymentError | undefined;
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
      refusal = new PaymentError("asset_not_allowed", "The seller asks for an asset not allowed.");
    } else if (affordable.length === 0) {
      refusal = new PaymentError("over_price_limit", "The price is over the per-call limit.");
    }
    return affordable;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    const amount = BigInt(offer.amount);
    const already = spent.get(offer.asset) ?? 0n;
    if (already + amount > config.assets[offer.asset]!.budget) {
      refusal = new PaymentError("over_budget", "The payment would exceed the budget.");
      return { abort: true, reason: refusal.code };
    }
    // Counted as spent now, in the same synchronous step as the check, so two calls at once cannot
    // both pass; never given back, so a seller cannot get it back into the budget by claiming failure.
    spent.set(offer.asset, already + amount);
    paid = { network: offer.network, asset: offer.asset, amount };
  });
  // Nothing was sent: signing failed (an unfunded payer fails here, in simulation).
  client.onPaymentCreationFailure(async ({ error }) => {
    signingError = error;
  });

  const pay = wrapFetchWithPayment(guardedFetch(config.maxResponseBytes, timeoutMs), client);
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
        error instanceof PaymentError
          ? `${error.code}: ${error.detail ?? error.message}`
          : String(error);
      throw new PaymentError(
        "payment_unknown",
        "The payment's outcome is unknown; it counts as spent.",
        detail,
      );
    }
    if (error instanceof PaymentError) throw error;
    if (refusal) throw refusal;
    if (signingError) {
      // The payer's simulation fails in the asset contract: #10 is a balance too low, #13 a missing
      // trustline (measured on testnet: `HostError: Error(Contract, #13)` for an account without USDC).
      if (/Error\(Contract, #(10|13)\)/.test(String(signingError))) {
        throw new PaymentError(
          "insufficient_funds",
          "The payer does not hold enough of the asset.",
          String(signingError),
        );
      }
      throw new PaymentError(
        "payment_failed",
        "The payment could not be created.",
        String(signingError),
      );
    }
    // The seller's 402 named no network, scheme or price this server can pay with.
    throw new PaymentError(
      "unsupported_payment",
      "The seller asks for a payment this server cannot make.",
      String(error),
    );
  }

  const body = await response.text();
  const contentType = response.headers.get("content-type")?.slice(0, LIMITS.mimeTypeChars) ?? null;
  if (!paid) return { status: response.status, contentType, body };
  let settle;
  try {
    settle = new x402HTTPClient(client).getPaymentSettleResponse((name) =>
      response.headers.get(name),
    );
  } catch (error) {
    // A seller that answers 402 again without a settlement refused the payment before settling it.
    if (response.status === 402) {
      throw new PaymentError(
        "payment_rejected",
        "The seller refused the payment.",
        body.slice(0, 500),
      );
    }
    throw new PaymentError(
      "payment_unknown",
      "The payment's outcome is unknown; it counts as spent.",
      String(error),
    );
  }
  if (!settle.success) {
    throw new PaymentError(
      "payment_rejected",
      "The seller's facilitator refused the payment.",
      settle.errorReason,
    );
  }
  // A Stellar transaction hash is 64 hex characters; anything else is not a settlement we can show.
  if (!/^[0-9a-f]{64}$/i.test(settle.transaction)) {
    throw new PaymentError(
      "payment_unknown",
      "The seller reported a settlement without a transaction.",
    );
  }
  return {
    status: response.status,
    contentType,
    body,
    payment: {
      transaction: settle.transaction,
      network: paid.network,
      asset: paid.asset,
      amount: paid.amount.toString(),
    },
  };
}
