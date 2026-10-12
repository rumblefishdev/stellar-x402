import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import { x402Client, x402HTTPClient, type SchemeRegistration } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";

export interface PaymentConfig {
  /** Scheme clients holding the buyer's key; the CLI registers `ExactStellarScheme` for testnet. */
  schemes: SchemeRegistration[];
  /** Per asset contract: the largest price one call may pay and the budget for this process, in atomic units. */
  assets: Record<string, { maxPerCall: bigint; budget: bigint }>;
  /** Abort a seller request after this long, so a call always ends. */
  timeoutMs: number;
  /** Refuse a seller response body larger than this. */
  maxResponseBytes: number;
  /** Allow `http` and loopback or private hosts: only for a seller run locally in tests. */
  allowInsecureLocal?: boolean;
}

export type PaymentErrorCode =
  | "unsafe_url"
  | "network_not_allowed"
  | "asset_not_allowed"
  | "over_price_limit"
  | "over_budget"
  | "payment_failed"
  | "payment_rejected"
  | "payment_unknown"
  | "response_too_large"
  | "upstream_error";

/**
 * A failure with its code. `message` is safe to show the agent; `cause` (a library or seller error)
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
  payment?: { transaction: string; network: string; asset: string; amount: string; payer?: string };
}

/** What every call has paid so far, per asset; shared by all calls of one process. */
export type Spent = Map<string, bigint>;

/**
 * Loopback, private, link-local, carrier-grade NAT and unspecified ranges: a catalog entry naming one
 * of these would make the buyer's machine call into its own network.
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

function isPrivate(ip: string): boolean {
  const family = isIP(ip);
  // An address in a form we cannot classify is treated as unsafe.
  if (family === 0) return true;
  return PRIVATE.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** https only, and every address the host resolves to must be public. */
async function checkUrl(raw: string, allowInsecureLocal: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new PaymentError("unsafe_url", "url is not a URL.", String(error));
  }
  if (allowInsecureLocal) return url;
  if (url.protocol !== "https:")
    throw new PaymentError("unsafe_url", "Only https URLs are called.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivate)) {
    throw new PaymentError("unsafe_url", "The URL points at a loopback or private address.");
  }
  return url;
}

/**
 * The fetch the payment wrapper uses: no redirects (the paid retry carries the signed payment, which
 * must not reach another host), a timeout, and a body size cap.
 */
function guardedFetch(config: PaymentConfig): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await fetch(request, {
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new PaymentError(
        "unsafe_url",
        "The seller answered with a redirect, which is not followed.",
      );
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > config.maxResponseBytes) {
      throw new PaymentError("response_too_large", "The seller's response is too large.");
    }
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

/** The price check every payment passes before anything is signed. */
function admit(requirements: PaymentRequirements, config: PaymentConfig, spent: Spent): bigint {
  if (requirements.network !== STELLAR_NETWORKS.testnet) {
    throw new PaymentError("network_not_allowed", `Only ${STELLAR_NETWORKS.testnet} is paid.`);
  }
  const limits = config.assets[requirements.asset];
  if (!limits)
    throw new PaymentError("asset_not_allowed", "The seller asks for an asset not allowed.");
  const amount = BigInt(requirements.amount);
  if (amount > limits.maxPerCall) {
    throw new PaymentError("over_price_limit", "The price is over the per-call limit.");
  }
  const already = spent.get(requirements.asset) ?? 0n;
  if (already + amount > limits.budget) {
    throw new PaymentError("over_budget", "The payment would exceed the budget.");
  }
  // Reserved now, in the same synchronous step as the check, so two calls at once cannot both pass.
  spent.set(requirements.asset, already + amount);
  return amount;
}

export async function callPaidHttp(
  request: { url: string; method: string; headers?: Record<string, string>; body?: string },
  config: PaymentConfig,
  spent: Spent,
): Promise<PaidResponse> {
  const url = await checkUrl(request.url, config.allowInsecureLocal ?? false);

  // One client per call, so its hooks know which reservation is this call's.
  const client = x402Client.fromConfig({ schemes: config.schemes, spendControls: false });
  let reserved: { asset: string; amount: bigint } | undefined;
  // Set once a payment passed the limits; `reserved` is cleared again if it is given back.
  let attempted = false;
  let refusal: PaymentError | undefined;
  let signingError: Error | undefined;
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    try {
      const amount = admit(selectedRequirements, config, spent);
      reserved = { asset: selectedRequirements.asset, amount };
      attempted = true;
    } catch (error) {
      if (!(error instanceof PaymentError)) throw error;
      refusal = error;
      return { abort: true, reason: error.code };
    }
  });
  const release = () => {
    if (!reserved) return;
    spent.set(reserved.asset, (spent.get(reserved.asset) ?? 0n) - reserved.amount);
    reserved = undefined;
  };
  // Nothing was signed or sent: signing failed (an unfunded payer fails here, in simulation).
  client.onPaymentCreationFailure(async ({ error }) => {
    signingError = error;
    release();
  });
  client.onPaymentResponse(async ({ settleResponse, paymentRequired }) => {
    // Released only when the seller's facilitator says no money moved; an unknown outcome stays spent.
    if (settleResponse?.success === false || (!settleResponse && paymentRequired)) release();
  });

  const pay = wrapFetchWithPayment(guardedFetch(config), client);
  let response: Response;
  try {
    response = await pay(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (error) {
    if (refusal) throw refusal;
    if (error instanceof PaymentError) throw error;
    const detail = String(error);
    if (signingError) {
      throw new PaymentError(
        "payment_failed",
        "The payment could not be created.",
        String(signingError),
      );
    }
    if (reserved) {
      throw new PaymentError(
        "payment_unknown",
        "The payment's outcome is unknown; it counts as spent.",
        detail,
      );
    }
    throw new PaymentError("upstream_error", "The request to the seller failed.", detail);
  }

  const body = await response.text();
  if (!attempted) {
    return { status: response.status, contentType: response.headers.get("content-type"), body };
  }
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
  if (!settle.success || !reserved) {
    throw new PaymentError(
      "payment_rejected",
      "The seller's facilitator refused the payment.",
      settle.errorReason,
    );
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
    payment: {
      transaction: settle.transaction,
      network: settle.network,
      asset: reserved.asset,
      amount: reserved.amount.toString(),
      payer: settle.payer,
    },
  };
}
