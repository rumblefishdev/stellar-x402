import { createHash, randomBytes } from "node:crypto";
import { STELLAR_NETWORKS } from "@stellar-x402/config";

/**
 * An API key (0105): `x402_` and 32 random bytes in base64url, 48 characters. The prefix lets a
 * secret scanner and a reader of a config file tell what the string is.
 */
const API_KEY = /^x402_[A-Za-z0-9_-]{43}$/;

/** `Authorization: Bearer <key>` (RFC 6750); the scheme's case is free, as RFC 9110 has it. */
const BEARER = /^Bearer +(\S+)$/i;

/** A new key. It is shown to its owner once; the registry gets {@link apiKeyHash} of it. */
export const newApiKey = (): string => `x402_${randomBytes(32).toString("base64url")}`;

/**
 * What the registry stores and looks a key up by: its SHA-256 in lower-case hex. A key is 256
 * random bits, so nothing can guess it from the hash, and a salt or a slow hash would add nothing
 * but a cost on every request.
 */
export const apiKeyHash = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

/**
 * The key of an `Authorization` header, or `undefined` when the header holds anything but
 * `Bearer` and one well-formed key. A key that isn't well-formed can't be in the registry, so it
 * is refused without a read.
 */
export function bearerApiKey(authorization: string): string | undefined {
  const key = BEARER.exec(authorization)?.[1];
  return key !== undefined && API_KEY.test(key) ? key : undefined;
}

/**
 * Whether a request for `network` must carry an API key: `stellar:pubnet` does, and every other
 * network, testnet first, takes none (ADR 0007's amendment of 2026-11-03). `network` is the
 * request's own `paymentRequirements.network`, unchecked, so it may be anything.
 */
export const requiresApiKey = (network: unknown): boolean => network === STELLAR_NETWORKS.pubnet;
