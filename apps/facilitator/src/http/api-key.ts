import { isApiKey } from "@stellar-x402/api-keys";
import { STELLAR_NETWORKS } from "@stellar-x402/config";

/** `Authorization: Bearer <key>` (RFC 6750); the scheme's case is free, as RFC 9110 has it. */
const BEARER = /^Bearer +(\S+)$/i;

/**
 * The key of an `Authorization` header, or `undefined` when the header holds anything but
 * `Bearer` and one well-formed key. A key that isn't well-formed can't be in the registry, so it
 * is refused without a read.
 */
export function bearerApiKey(authorization: string): string | undefined {
  const key = BEARER.exec(authorization)?.[1];
  return key !== undefined && isApiKey(key) ? key : undefined;
}

/**
 * Whether a request for `network` must carry an API key: `stellar:pubnet` does, and every other
 * network, testnet first, takes none (ADR 0007's amendment of 2026-11-03). `network` is the
 * request's own `paymentRequirements.network`, unchecked, so it may be anything.
 */
export const requiresApiKey = (network: unknown): boolean => network === STELLAR_NETWORKS.pubnet;
