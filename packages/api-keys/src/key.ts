import { createHash, randomBytes } from "node:crypto";

/**
 * An API key (0105): `x402_` and 32 random bytes in base64url, 48 characters. The prefix lets a
 * secret scanner and a reader of a config file tell what the string is.
 */
const API_KEY = /^x402_[A-Za-z0-9_-]{43}$/;

/** A new key. The registry gets {@link apiKeyHash} of it, never the key. */
export const newApiKey = (): string => `x402_${randomBytes(32).toString("base64url")}`;

/** Whether `key` has a key's form. One that hasn't can't be in the registry. */
export const isApiKey = (key: string): boolean => API_KEY.test(key);

/**
 * What the registry stores and looks a key up by: its SHA-256 in lower-case hex. A key is 256
 * random bits, so nothing can guess it from the hash, and a salt or a slow hash would add nothing
 * but a cost on every request.
 */
export const apiKeyHash = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");
