import type { PaymentRequirements } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { CATALOG_KEY_VERSION } from "./limits.js";
import { eraseParamNames, type CatalogKey } from "./url.js";
import type { ValidationResult } from "./validate.js";

export interface NormalizedEntry {
  key: CatalogKey;
  keyVersion: typeof CATALOG_KEY_VERSION;
  /** Upstream shape; `accepts` holds the one paid requirement; the caller stamps `lastUpdated`. */
  resource: Omit<DiscoveryResource, "lastUpdated">;
}

/**
 * Builds the catalog entry from an accepted listing. `network` and `payTo` come from the verified
 * requirements, never from the client-echoed extension block. Throws only on a result that
 * `validate()` couldn't have produced.
 */
export function normalize(
  result: Extract<ValidationResult, { ok: true }>,
  requirements: PaymentRequirements,
): NormalizedEntry {
  const { discovered } = result;
  const type = discovered.discoveryInfo.input.type === "mcp" ? "mcp" : "http";
  const method = "toolName" in discovered ? discovered.toolName : discovered.method;
  if (!method) throw new Error("normalize: the validation result has no method or tool name");
  // Built from the validated URL and template, not re-validated, so `validate()` options carry.
  // The listing shows the erased template too, so payments that name the parameter differently
  // don't keep rewriting it.
  const resourceUrl = result.routeTemplate
    ? `${new URL(result.resourceUrl).origin}${eraseParamNames(result.routeTemplate)}`
    : result.resourceUrl;
  const key: CatalogKey = {
    network: requirements.network,
    payTo: requirements.payTo,
    method,
    resourceUrl,
  };
  const resource: Omit<DiscoveryResource, "lastUpdated"> = {
    resource: resourceUrl,
    type,
    x402Version: discovered.x402Version,
    accepts: [requirements],
  };
  if (discovered.description !== undefined) resource.description = discovered.description;
  if (discovered.mimeType !== undefined) resource.mimeType = discovered.mimeType;
  if (discovered.serviceName !== undefined) resource.serviceName = discovered.serviceName;
  if (discovered.tags !== undefined) resource.tags = discovered.tags;
  if (discovered.iconUrl !== undefined) resource.iconUrl = discovered.iconUrl;
  if (discovered.extensions !== undefined) resource.extensions = discovered.extensions;

  return { key, keyVersion: CATALOG_KEY_VERSION, resource };
}
