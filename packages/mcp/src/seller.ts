import { BlockList, isIP } from "node:net";
import { isSchemaWithinLimits, LIMITS } from "@stellar-x402/bazaar";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";
import { ToolError } from "./results.js";

/** How this server talks to sellers, for a preview and a payment alike. */
export interface SellerLimits {
  /** Give up on a seller request after this long, so a call always ends. */
  timeoutMs: number;
  /** Refuse a seller response body larger than this. */
  maxResponseBytes: number;
  /** Allow `http` and loopback or private hosts: only for a seller run locally in tests. */
  allowInsecureLocal: boolean;
}

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
export function checkUrl(raw: string, allowInsecureLocal: boolean): URL {
  if (!URL.canParse(raw)) throw new ToolError("unsafe_url", "url is not a URL.");
  const url = new URL(raw);
  if (allowInsecureLocal) return url;
  if (url.protocol !== "https:") throw new ToolError("unsafe_url", "Only https URLs are called.");
  // `localhost.` is the same host as `localhost`: a name may end with the root's dot.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const family = isIP(host);
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (family !== 0 && PRIVATE.check(host, family === 6 ? "ipv6" : "ipv4"));
  if (local) throw new ToolError("unsafe_url", "The URL points at a loopback or private address.");
  return url;
}

/**
 * The fetch the payment wrapper uses: no redirects (the paid retry carries the signed payment, which
 * must not reach another host), a timeout, and a body size cap counted while the body arrives.
 */
export function guardedFetch(maxResponseBytes: number, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetch(new Request(input, init), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ToolError("upstream_error", "The request to the seller failed.", String(error));
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ToolError(
        "unsafe_url",
        "The seller answered with a redirect, which is not followed.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > maxResponseBytes) {
          throw new ToolError("response_too_large", "The seller's response is too large.");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      // The timeout covers the body too: a seller that sends its headers and then stalls ends here.
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "upstream_error",
        "The seller's response did not arrive in full.",
        String(error),
      );
    }
    // A 204 or 304 must not be given a body, not even an empty one.
    const body = size === 0 ? null : Buffer.concat(chunks);
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

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
  // A price can depend on the body (e.g. how many results are asked for), so the body is sent too.
  const headers = request.body === undefined ? undefined : { "content-type": "application/json" };
  const response = await guardedFetch(limits.maxResponseBytes, limits.timeoutMs)(url, {
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
  // The terms come in a header, which Node's HTTP client caps at 16 KiB; inside that, the input
  // schema gets the depth and size bounds our catalog puts on a listing.
  const bazaar = paymentRequired.extensions?.bazaar as { schema?: unknown } | undefined;
  if (!isSchemaWithinLimits(bazaar?.schema)) {
    throw new ToolError(
      "unsupported_payment",
      "The seller's input schema is over the catalog's limits.",
    );
  }
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
