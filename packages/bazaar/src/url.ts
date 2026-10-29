import { isValidIconUrl, isValidRouteTemplate } from "@x402/extensions/bazaar";
import { LIMITS } from "./limits.js";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const UNRESERVED = /[A-Za-z0-9\-._~]/;
const STATIC_SEGMENT = /^[A-Za-z0-9_.~-]+$/;
const PARAM_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Special-use and private names and their subdomains: RFC 6761 (`localhost`, `invalid`, `test`,
 * `example`), 6762 (`local`), 8375 (`home.arpa`), 9476 (`alt`), 7686 (`onion`), ICANN `.internal`,
 * the TLDs ICANN will never delegate (2018: `home`, `corp`, `mail`), and `localdomain`. None of
 * them is a public DNS name. `.lan` is left out: common in routers, but not reserved.
 */
const PRIVATE_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "home.arpa",
  "invalid",
  "test",
  "example",
  "alt",
  "onion",
  "home",
  "corp",
  "mail",
];

/**
 * Hosts that are not a public DNS name: IP literals (WHATWG has already turned decimal, hex and
 * octal IPv4 forms into dotted quads, and serializes IPv6 bracketed), single-label names such as
 * `intranet`, trailing-dot names, and private suffixes. Refused for icons on top of upstream's
 * icon host rules, and for resource URLs (`isPublicResourceUrl`).
 */
function isForbiddenHost(hostname: string): boolean {
  return (
    hostname.startsWith("[") ||
    IPV4.test(hostname) ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  );
}

/** RFC 3986 §6.2.2: decode percent-encoded unreserved characters and uppercase the remaining hex. */
function normalizePercentEncoding(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/** What a listing is, from `info.input.type`; it decides which resource URL schemes it may use. */
export type ResourceType = "http" | "mcp";

/**
 * Resource URL schemes per listing type. `http:` and loopback hosts are what upstream servers send
 * by default (e2e suite, local sellers); `mcp:` is `@x402/mcp`'s `mcp://tool/<name>`, a name rather
 * than an address, so only an `mcp` listing may use it. `canonicalizeUrl` puts no host rules on
 * `http(s)`: the facilitator never fetches a resource URL (ADR 0008), and a client that does checks
 * the address it resolves (`packages/seller-fetch` guard), which no check on the URL text can match. The
 * validator also requires a public host (`isPublicResourceUrl`), for listing quality, unless
 * `listLocal` is set.
 * An `mcp:` host must be a DNS-style name (`MCP_HOST`), for one canonical form.
 */
const RESOURCE_SCHEMES: Record<ResourceType, readonly string[]> = {
  http: ["https:", "http:"],
  mcp: ["https:", "http:", "mcp:"],
};

/**
 * An `mcp:` host: a DNS-style name of labels up to 63 characters, lowercased first, since WHATWG
 * keeps the case of opaque hosts.
 */
const MCP_HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseUrl(raw: string): URL | undefined {
  if (raw.length > LIMITS.urlChars) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** Icons only: https, and upstream's host rules plus ours, since a browser fetches every icon. */
function parseIconUrl(raw: string): URL | undefined {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return undefined;
  // Upstream's host rules (loopback names, IP forms), then ours.
  if (!isValidIconUrl(url.href) || isForbiddenHost(url.hostname)) return undefined;
  return url;
}

/**
 * The canonical form of a resource URL, or `undefined` when it can't be cataloged.
 *
 * The scheme must be one `type` allows (`RESOURCE_SCHEMES`); no userinfo, no host ending in a
 * dot (`x.com.` would key apart from `x.com`). The query and fragment are dropped, dot segments
 * resolved and percent-encoding normalized; path case and the trailing slash are kept (RFC 9110:
 * only scheme and host are case-insensitive). `http(s)`: the default port is dropped. `mcp`:
 * `mcp://<host>[:port]<path>` with a lowercased DNS-style host and `/` for an empty path, as
 * `http(s)` has; WHATWG gives it the `origin` `"null"`, so it is built by hand (0030 gap G11), and
 * keeps a backslash, which other parsers read as a separator, so one is refused.
 */
export function canonicalizeUrl(raw: string, type: ResourceType): string | undefined {
  const url = parseUrl(raw);
  const schemes = Object.hasOwn(RESOURCE_SCHEMES, type) ? RESOURCE_SCHEMES[type] : undefined;
  if (!url || !schemes?.includes(url.protocol)) return undefined;
  if (url.username !== "" || url.password !== "" || url.hostname.endsWith(".")) return undefined;
  if (url.pathname.includes("//")) return undefined;
  let canonical: string;
  if (url.protocol === "mcp:") {
    const host = url.hostname.toLowerCase();
    if (!MCP_HOST.test(host) || url.pathname.includes("\\")) return undefined;
    const port = url.port === "" ? "" : `:${url.port}`;
    canonical = `mcp://${host}${port}${normalizePercentEncoding(url.pathname || "/")}`;
  } else {
    canonical = `${url.origin}${normalizePercentEncoding(url.pathname)}`;
  }
  return canonical.length > LIMITS.urlChars ? undefined : canonical;
}

/**
 * Whether a canonical resource URL may be listed (0054, ADR 0008), on every network unless the
 * validator's `listLocal` is set: `http(s)` with a host that is a public DNS name, not an IP
 * literal, loopback, private, special-use or single-label name (`isForbiddenHost`, the icon rule).
 * Listing quality, not SSRF: no buyer can reach such a host, and a public name that resolves to
 * one still passes, as the fetcher checks the address. An `mcp:` URL names a tool, not a server a
 * buyer can reach, so it is refused too.
 */
export function isPublicResourceUrl(canonical: string): boolean {
  const url = new URL(canonical);
  return (url.protocol === "https:" || url.protocol === "http:") && !isForbiddenHost(url.hostname);
}

/**
 * Our checks on top of upstream `isValidIconUrl`: https only, no backslash (parser differential),
 * no IP literal, loopback, private or single-label host. Returns the canonical `href` without the
 * fragment, or `undefined` to drop the field.
 */
export function sanitizeIconUrl(raw: string | undefined): string | undefined {
  if (!isValidIconUrl(raw) || raw.includes("\\")) return undefined;
  const url = parseIconUrl(raw);
  if (!url) return undefined;
  url.hash = "";
  // Checked again after parsing: the parser percent-encodes, so the href can outgrow the input.
  return url.href.length > LIMITS.urlChars ? undefined : url.href;
}

/**
 * Checks a seller's `routeTemplate` against the canonical concrete path. Returns the template when
 * it passes upstream's rules and our stricter grammar, has a static segment, and matches the path
 * segment by segment; otherwise `undefined`, and the concrete path is used (spec fallback).
 */
export function matchRouteTemplate(template: string | undefined, path: string): string | undefined {
  if (template === undefined || template.length > LIMITS.routeTemplateChars) return undefined;
  if (!isValidRouteTemplate(template) || !template.startsWith("/")) return undefined;
  const wanted = template.slice(1).split("/");
  const actual = path.slice(1).split("/");
  if (wanted.length !== actual.length) return undefined;
  let hasStatic = false;
  for (const [i, segment] of wanted.entries()) {
    if (PARAM_SEGMENT.test(segment)) {
      if (actual[i] === "") return undefined;
      continue;
    }
    if (!STATIC_SEGMENT.test(segment) || segment === "." || segment === "..") return undefined;
    if (segment !== actual[i]) return undefined;
    hasStatic = true;
  }
  return hasStatic ? template : undefined;
}

/** `/users/:userId` → `/users/:`: parameter names are erased in the key (red team RT3). */
export function eraseParamNames(template: string): string {
  return template.replace(/\/:[A-Za-z_][A-Za-z0-9_]*/g, "/:");
}

/** `network + payTo + method + normalized URL` (AD-19). */
export interface CatalogKey {
  network: string;
  /** From the verified requirements, never from the extension. */
  payTo: string;
  /** HTTP method, or the tool name for `mcp`. */
  method: string;
  /** Canonical URL; for `http`, with an accepted template applied and its parameter names erased. */
  resourceUrl: string;
}
