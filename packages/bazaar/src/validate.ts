import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  extractDiscoveryInfo,
  validateDiscoveryExtensionSpec,
  type DiscoveredResource,
} from "@x402/extensions/bazaar";
import { LIMITS, type BazaarRejectReason } from "./limits.js";
import { isSchemaWithinLimits } from "./schema.js";
import { canonicalizeUrl, matchRouteTemplate, sanitizeIconUrl, type UrlOptions } from "./url.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Upstream's extraction without its URL fields: upstream builds `resourceUrl` as
 * `origin + routeTemplate` even for a template we discard, so neither is passed on.
 */
export type Discovered = DistributiveOmit<DiscoveredResource, "resourceUrl" | "routeTemplate">;

export type ValidationResult =
  | {
      ok: true;
      discovered: Discovered;
      /** `canonicalizeUrl(payload.resource.url)`: the concrete URL that was paid for. */
      resourceUrl: string;
      /** Set only when the seller's template passed our grammar and matched the path. */
      routeTemplate?: string;
      /** A template was sent and discarded (counted in metrics). */
      routeTemplateIgnored: boolean;
    }
  /** `detail` is for logs only and never goes into the header. */
  | { ok: false; reason: BazaarRejectReason; detail?: string };

/** The `EXTENSION-RESPONSES` value of a settle response (AD-8). */
export type ExtensionResponses = {
  bazaar: { status: "processing" } | { status: "rejected"; rejectedReason: BazaarRejectReason };
};

const CONTROL_CHARS = /\p{Cc}/u;
const TOKEN = "[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}";
const MIME_TYPE = new RegExp(
  `^${TOKEN}/${TOKEN}(\\s*;\\s*[A-Za-z0-9!#$&^_.+-]+=("[^"]*"|[A-Za-z0-9!#$&^_.+-]+))*$`,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(reason: BazaarRejectReason, detail?: string): ValidationResult {
  return { ok: false, reason, detail };
}

function serializedBytes(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return undefined;
  }
}

/** Our rules on top of `validateDiscoveryExtensionSpec`; returns a detail when the shape fails. */
function checkShape(
  input: Record<string, unknown>,
  resource: Record<string, unknown>,
): string | undefined {
  if (input.type === "http" && typeof input.method !== "string") {
    return "info.input.method is required for http";
  }
  if (input.type === "mcp") {
    const toolName = input.toolName as string;
    if (toolName.length > LIMITS.toolNameChars) return "toolName is too long";
    if (CONTROL_CHARS.test(toolName) || toolName.trim() !== toolName) {
      return "toolName has control characters or surrounding whitespace";
    }
  }
  const { description, mimeType } = resource;
  if (
    description !== undefined &&
    (typeof description !== "string" || CONTROL_CHARS.test(description.replace(/[\t\n\r]/g, "")))
  ) {
    return "resource.description must be a string without control characters";
  }
  if (
    mimeType !== undefined &&
    (typeof mimeType !== "string" ||
      mimeType.length > LIMITS.mimeTypeChars ||
      CONTROL_CHARS.test(mimeType) ||
      !MIME_TYPE.test(mimeType))
  ) {
    return "resource.mimeType is not a valid media type";
  }
  return undefined;
}

function run(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: UrlOptions,
): ValidationResult | undefined {
  // 1. Presence, read from the raw payload: upstream's `null` mixes several cases.
  const extensions: unknown = payload.extensions;
  if (!isRecord(extensions) || !Object.hasOwn(extensions, "bazaar")) return undefined;
  const raw = extensions.bazaar;
  if (!isRecord(raw)) return reject("invalid_extension", "extensions.bazaar is not an object");

  // 2. Version: the catalog takes x402 v2 only.
  if (payload.x402Version !== 2) return reject("unsupported_version");

  // 3. Size, before any walk. A block too deep to serialize is too large as well.
  const bytes = serializedBytes(raw);
  if (bytes === undefined || bytes > LIMITS.extensionBytes) return reject("too_large", "extension");

  // 4. Shape: upstream's trusted-shape check, then ours.
  const spec = validateDiscoveryExtensionSpec(raw);
  if (!spec.valid) return reject("invalid_info", spec.errors?.join("; "));
  const input = (raw.info as Record<string, unknown>).input as Record<string, unknown>;
  const resource: Record<string, unknown> = isRecord(payload.resource) ? payload.resource : {};
  const shapeError = checkShape(input, resource);
  if (shapeError) return reject("invalid_info", shapeError);

  // 5. Resource URL. This is also what keeps upstream's unguarded `new URL()` from throwing.
  const resourceUrl =
    typeof resource.url === "string" ? canonicalizeUrl(resource.url, options) : undefined;
  if (!resourceUrl) return reject("invalid_resource_url");

  // 6. Content limits. The schema is data: walked for limits, never compiled.
  if (
    typeof resource.description === "string" &&
    resource.description.length > LIMITS.descriptionChars
  ) {
    return reject("too_large", "description");
  }
  // The extension schema and mcp `inputSchema`. http `body`, `queryParams` and `pathParams` are
  // example values (their schemas sit in `raw.schema`), bounded by the size cap only.
  if (![raw.schema, input.inputSchema].every(isSchemaWithinLimits)) {
    return reject("schema_too_complex");
  }

  // 7. Upstream extraction, only now that it can't hit its known throws. `validate = false`:
  //    `true` would compile the seller's schema in-process.
  const extracted = extractDiscoveryInfo(payload, requirements, false);
  if (!extracted) return reject("internal_error", "extraction returned null");

  // 8. Template (http only): our grammar and a segment match against the canonical path.
  const rawTemplate = typeof raw.routeTemplate === "string" ? raw.routeTemplate : undefined;
  const routeTemplate =
    input.type === "http"
      ? matchRouteTemplate(rawTemplate, new URL(resourceUrl).pathname)
      : undefined;

  // Upstream echoes every client extension; only `bazaar` belongs in the catalog, and only with
  // the template we kept.
  const bazaarBlock: Record<string, unknown> = { ...raw };
  delete bazaarBlock.routeTemplate;
  if (routeTemplate) bazaarBlock.routeTemplate = routeTemplate;
  const discovered: Record<string, unknown> = { ...extracted, extensions: { bazaar: bazaarBlock } };
  delete discovered.resourceUrl;
  delete discovered.routeTemplate;
  const iconUrl = sanitizeIconUrl(extracted.iconUrl);
  if (iconUrl) discovered.iconUrl = iconUrl;
  else delete discovered.iconUrl;

  return {
    ok: true,
    discovered: discovered as Discovered,
    resourceUrl,
    ...(routeTemplate ? { routeTemplate } : {}),
    routeTemplateIgnored: rawTemplate !== undefined && routeTemplate === undefined,
  };
}

/**
 * Validates the `extensions.bazaar` block of a settled payment. Pure: no I/O, no env, no clock,
 * and never throws. Returns `undefined` only when the raw payload has no `extensions.bazaar` key.
 *
 * Our checks run on the raw payload first and upstream extraction runs last, so each failure gets
 * its own reason code instead of surfacing as `internal_error`.
 */
export function validate(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: UrlOptions = {},
): ValidationResult | undefined {
  try {
    return run(payload, requirements, options);
  } catch (error) {
    return reject("internal_error", error instanceof Error ? error.message : String(error));
  }
}

/** The header value for 0031. Never carries `detail`. */
export function toExtensionResponses(result: ValidationResult): ExtensionResponses {
  return result.ok
    ? { bazaar: { status: "processing" } }
    : { bazaar: { status: "rejected", rejectedReason: result.reason } };
}
