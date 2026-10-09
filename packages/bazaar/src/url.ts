import { isValidIconUrl, isValidRouteTemplate } from "@x402/extensions/bazaar";
import { LIMITS } from "./limits.js";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const UNRESERVED = /[A-Za-z0-9\-._~]/;
const STATIC_SEGMENT = /^[A-Za-z0-9_.~-]+$/;
const PARAM_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Hosts we never catalog: IP literals (WHATWG has already turned decimal, hex and octal IPv4 forms
 * into dotted quads), `localhost` and its subdomains, and trailing-dot names.
 */
function isForbiddenHost(hostname: string): boolean {
  return (
    hostname === "" ||
    hostname.startsWith("[") ||
    IPV4.test(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".")
  );
}

/** RFC 3986 §6.2.2: decode percent-encoded unreserved characters and uppercase the remaining hex. */
function normalizePercentEncoding(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/** Options shared by the URL checks. */
export interface UrlOptions {
  /**
   * Development only: also accept `http:` resource URLs. Host rules still apply (no IP literal,
   * `localhost` or trailing dot), and icons stay https-only. Off by default; the facilitator sets
   * it from its own config, since this package reads no env.
   */
  allowHttp?: boolean;
}

function parseWebUrl(raw: string, allowHttp = false): URL | undefined {
  if (raw.length > LIMITS.urlChars) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const schemeOk = url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  if (!schemeOk || url.username !== "" || url.password !== "") return undefined;
  if (isForbiddenHost(url.hostname)) return undefined;
  return url;
}

/**
 * The canonical form of a resource URL, or `undefined` when it can't be cataloged.
 *
 * https only (unless `allowHttp`); no userinfo, IP literal, `localhost` or trailing-dot host; the default port, query
 * and fragment are dropped; dot segments are resolved and percent-encoding normalized. Path case
 * and the trailing slash are kept (RFC 9110: only scheme and host are case-insensitive).
 */
export function canonicalizeUrl(raw: string, options: UrlOptions = {}): string | undefined {
  const url = parseWebUrl(raw, options.allowHttp);
  if (!url || url.pathname.includes("//")) return undefined;
  const canonical = `${url.origin}${normalizePercentEncoding(url.pathname)}`;
  return canonical.length > LIMITS.urlChars ? undefined : canonical;
}

/**
 * Our checks on top of upstream `isValidIconUrl`: https only, no backslash (parser differential),
 * no trailing-dot or `*.localhost` host. Returns the canonical `href` to store, or `undefined` to
 * drop the field.
 */
export function sanitizeIconUrl(raw: string | undefined): string | undefined {
  if (!isValidIconUrl(raw) || raw.includes("\\")) return undefined;
  return parseWebUrl(raw)?.href;
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

export interface CatalogKeyInput {
  network: string;
  payTo: string;
  type: "http" | "mcp";
  method?: string;
  toolName?: string;
  resourceUrl: string;
  routeTemplate?: string;
}

/** The catalog key, or `undefined` when the input can't be cataloged. */
export function catalogKey(
  input: CatalogKeyInput,
  options: UrlOptions = {},
): CatalogKey | undefined {
  const canonical = canonicalizeUrl(input.resourceUrl, options);
  if (!canonical || !input.network || !input.payTo) return undefined;
  const method = input.type === "mcp" ? input.toolName : input.method;
  if (!method) return undefined;
  let resourceUrl = canonical;
  if (input.type === "http") {
    const { origin, pathname } = new URL(canonical);
    const template = matchRouteTemplate(input.routeTemplate, pathname);
    if (template) resourceUrl = `${origin}${eraseParamNames(template)}`;
  }
  return { network: input.network, payTo: input.payTo, method, resourceUrl };
}
