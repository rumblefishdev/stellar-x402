import { lookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Why a seller request was refused or failed. `message` can reach the caller's own client as is (the
 * buyer's MCP server shows it to the agent), so it holds nothing from the seller; `detail` (a library
 * or seller error) is for logs only.
 */
export class SellerFetchError extends Error {
  constructor(
    readonly code: "unsafe_url" | "upstream_error" | "response_too_large",
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** How requests to one seller are bounded. */
export interface SellerLimits {
  /** Give up after this long, all of one caller's requests to the seller together. */
  timeoutMs: number;
  /** Refuse a seller response body larger than this. */
  maxResponseBytes: number;
  /**
   * Also allow `http` to this machine (`localhost`, `*.localhost`, 127.0.0.0/8, `::1`): only for a
   * seller run locally in tests. Every other host keeps the https and public-address rules.
   */
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
 * This machine: `localhost` and `*.localhost` (names reserved for loopback, RFC 6761) or a loopback
 * address. The only hosts `allowInsecureLocal` opens, so a test seller on this machine is reachable
 * while private networks and plain http elsewhere stay closed.
 */
function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && ipaddr.process(host).range() === "loopback";
}

/**
 * Resolves a name as the connection does and refuses it when any address is in the caller's own
 * network. A public name can point there and still have a public certificate (an internal service
 * with a Let's Encrypt certificate), so https alone does not stop it. The address checked is the one
 * connected to, so DNS cannot answer differently in between.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (addresses.some((a) => isNotPublic(a.address))) {
      const refused = new SellerFetchError(
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
 * With `allowInsecureLocal`, http or https to this machine passes too.
 */
export function checkUrl(raw: string, allowInsecureLocal: boolean): URL {
  if (!URL.canParse(raw)) throw new SellerFetchError("unsafe_url", "url is not a URL.");
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const web = url.protocol === "http:" || url.protocol === "https:";
  if (allowInsecureLocal && web && isLoopback(host)) return url;
  if (url.protocol !== "https:")
    throw new SellerFetchError("unsafe_url", "Only https URLs are called.");
  const local = isIP(host) !== 0 && isNotPublic(host);
  if (local)
    throw new SellerFetchError("unsafe_url", "The URL points at an address that is not public.");
  return url;
}

/**
 * A fetch to sellers: only public addresses, no redirects (a paid retry carries the signed payment,
 * which must not reach another host), a deadline, and a body size cap counted while
 * the body arrives. `deadline` is the caller's, `AbortSignal.timeout(timeoutMs)` made once when its
 * work starts: it covers every request made through this fetch, so a request still running at
 * `timeoutMs`, or started after it, is cut off. Work between requests (a payment's signing) is not.
 * A request's own `signal` ends it earlier: an MCP client closing its event stream.
 */
export function guardedFetch(limits: SellerLimits, deadline: AbortSignal): typeof fetch {
  // Every name is checked where it is connected to. undici's own `maxResponseSize` is not used: it
  // counts the bytes on the wire, so a small gzip body that unpacks to gigabytes would pass it.
  // A loopback name opened by allowInsecureLocal resolves as usual; every other name is checked.
  const guardedLookup: LookupFunction = (hostname, options, callback) =>
    limits.allowInsecureLocal && isLoopback(hostname)
      ? lookup(hostname, options, callback)
      : publicOnlyLookup(hostname, options, callback);
  const dispatcher = new Agent({ connect: { lookup: guardedLookup } });
  return async (input, init) => {
    const request = new Request(input, init);
    // Every request made through this fetch passes here, so the guard holds whoever calls it.
    checkUrl(request.url, limits.allowInsecureLocal);
    let response;
    try {
      response = await undiciFetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        body: request.body ? await request.arrayBuffer() : undefined,
        redirect: "manual",
        signal: AbortSignal.any([deadline, request.signal]),
        dispatcher,
      });
    } catch (error) {
      // A refusal from publicOnlyLookup comes back as the cause of undici's "fetch failed".
      if (error instanceof Error && error.cause instanceof SellerFetchError) throw error.cause;
      throw new SellerFetchError(
        "upstream_error",
        "The request to the seller failed.",
        String(error),
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SellerFetchError(
        "unsafe_url",
        "The seller answered with a redirect, which is not followed.",
      );
    }
    // Counted after decompression, as the body is read: the limit holds for what reaches the caller.
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > limits.maxResponseBytes) {
          throw new SellerFetchError("response_too_large", "The seller's response is too large.");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof SellerFetchError) throw error;
      // The deadline covers the body too: a seller that sends its headers and then stalls ends here.
      throw new SellerFetchError(
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
