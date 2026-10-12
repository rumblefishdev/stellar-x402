import type { ExtensionResponses } from "@stellar-x402/bazaar";
import { safeBase64Encode } from "@x402/core/utils";

export const EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES";

/** Base64 JSON, as upstream `HTTPFacilitatorClient` decodes it. Set before the body is written. */
export function encodeExtensionResponses(value: ExtensionResponses): string {
  return safeBase64Encode(JSON.stringify(value));
}
