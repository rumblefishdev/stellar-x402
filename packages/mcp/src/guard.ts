import { lookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { ToolError } from "./results.js";

/** How this server talks to sellers, for a preview and a payment alike. */
export interface SellerLimits {
  /**
   * Give up on a tool call after this long, all its seller requests together, so a call ends before
   * the MCP client stops waiting and the agent always gets an answer.
   */
  timeoutMs: number;
  /** Refuse a seller response body larger than this. */
  maxResponseBytes: number;
  /** Allow `http` and loopback or private hosts: only for a seller run locally in tests. */
  allowInsecureLocal: boolean;
}

/**
 * Only an ordinary public address passes: `ipaddr.js` names every special range (private, loopback,
 * link-local, multicast, reserved, unique-local, carrier-grade NAT, NAT64, 6to4, …) and calls a plain
 * public one `unicast`. A range nobody listed is refused by default.
 */
function isNotPublic(ip: string): boolean {
  const address = ipaddr.process(ip);
  // ipaddr.js calls the deprecated IPv4-compatible form (`::a.b.c.d`) `unicast`; it is not a public
  // address, so it is refused too.
  const ipv4Compatible =
    address.kind() === "ipv6" && (address as ipaddr.IPv6).match(ipaddr.IPv6.parse("::"), 96);
  return ipv4Compatible || address.range() !== "unicast";
}

/**
 * Resolves a name as the connection does and refuses it when any address is in the buyer's own
 * network. A public name can point there and still have a public certificate (an internal service
 * with a Let's Encrypt certificate), so https alone does not stop it. The address checked is the one
 * connected to, so DNS cannot answer differently in between.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (addresses.some((a) => isNotPublic(a.address))) {
      const refused = new ToolError(
        "unsafe_url",
        "The URL's host resolves to an address that is not public.",
      );
      return callback(refused as NodeJS.ErrnoException, "");
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/**
 * https only, and no private IP address written in the URL: an address is connected to without a
 * lookup, so it is checked here; a name, `localhost` included, when it is resolved (`publicOnlyLookup`).
 */
export function checkUrl(raw: string, allowInsecureLocal: boolean): URL {
  if (!URL.canParse(raw)) throw new ToolError("unsafe_url", "url is not a URL.");
  const url = new URL(raw);
  if (allowInsecureLocal) return url;
  if (url.protocol !== "https:") throw new ToolError("unsafe_url", "Only https URLs are called.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = isIP(host) !== 0 && isNotPublic(host);
  if (local) throw new ToolError("unsafe_url", "The URL points at an address that is not public.");
  return url;
}

/** A GET carries no body: fetch would throw, and the mistake is the agent's input, not the seller. */
export function checkBody(method: string, body: string | undefined): void {
  if (method === "GET" && body !== undefined) {
    throw new ToolError("invalid_input", "A GET request cannot carry a body.");
  }
}

/**
 * The fetch the payment wrapper uses: only public addresses, no redirects (the paid retry carries the
 * signed payment, which must not reach another host), a deadline, and a body size cap counted while
 * the body arrives. Build one per tool call: the deadline starts here and covers every request made
 * through it, so a payment's unpaid request, signing and paid retry together end within `timeoutMs`.
 */
export function guardedFetch(limits: SellerLimits): typeof fetch {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  // Every name is checked where it is connected to. undici's own `maxResponseSize` is not used: it
  // counts the bytes on the wire, so a small gzip body that unpacks to gigabytes would pass it.
  const dispatcher = new Agent({
    connect: limits.allowInsecureLocal ? {} : { lookup: publicOnlyLookup },
  });
  return async (input, init) => {
    const request = new Request(input, init);
    // Every request the payment wrapper makes passes here, so the guard holds whoever calls this.
    checkUrl(request.url, limits.allowInsecureLocal);
    let response;
    try {
      response = await undiciFetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        body: request.body ? await request.arrayBuffer() : undefined,
        redirect: "manual",
        signal: deadline,
        dispatcher,
      });
    } catch (error) {
      // A refusal from publicOnlyLookup comes back as the cause of undici's "fetch failed".
      if (error instanceof Error && error.cause instanceof ToolError) throw error.cause;
      throw new ToolError("upstream_error", "The request to the seller failed.", String(error));
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ToolError(
        "unsafe_url",
        "The seller answered with a redirect, which is not followed.",
      );
    }
    // Counted after decompression, as the body is read: the limit holds for what reaches the agent.
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > limits.maxResponseBytes) {
          throw new ToolError("response_too_large", "The seller's response is too large.");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      // The deadline covers the body too: a seller that sends its headers and then stalls ends here.
      throw new ToolError(
        "upstream_error",
        "The seller's response did not arrive in full.",
        String(error),
      );
    }
    // A 204 or 304 must not be given a body, not even an empty one.
    const body = size === 0 ? null : Buffer.concat(chunks);
    return new Response(body, { status: response.status, headers: [...response.headers] });
  };
}
