/** A key's SHA-256 as the registry stores it: 64 lower-case hex digits. */
const API_KEY_HASH = /^[0-9a-f]{64}$/;

/** The longest API key owner. It is part of a rate-limit key, which a b-tree index must hold. */
export const API_KEY_OWNER_MAX_LENGTH = 128;

/** `<kind>:<id>`, e.g. `operator:acme-weather` or `discord:412345678901234567` (0105). */
const API_KEY_OWNER = /^[a-z]+:[a-z0-9][a-z0-9_-]*$/;

/** Whether `owner` is an API key owner the registry takes; `0013_api_keys` checks the same. */
export const isApiKeyOwner = (owner: string): boolean =>
  owner.length <= API_KEY_OWNER_MAX_LENGTH && API_KEY_OWNER.test(owner);

/**
 * Rejects what the registry must never hold: anything but a SHA-256 in the hash column, where a
 * caller's mistake would put the key itself, and an owner that isn't `<kind>:<id>`.
 */
export function assertApiKey(hash: string, owner: string): void {
  if (!API_KEY_HASH.test(hash))
    throw new RangeError("an API key hash must be 64 lower-case hex digits");
  if (!isApiKeyOwner(owner))
    throw new RangeError(
      `an API key owner must be <kind>:<id> in a-z, 0-9, "_" and "-", at most ${API_KEY_OWNER_MAX_LENGTH} characters`,
    );
}

/** The longest sealed copy of a key the registry's issuer may store (0106). */
export const SEALED_KEY_MAX_BYTES = 1024;

/** Rejects a sealed copy the table would refuse: an empty one, or one over the limit. */
export function assertSealedKey(sealed: Buffer): void {
  if (!Buffer.isBuffer(sealed) || sealed.length === 0 || sealed.length > SEALED_KEY_MAX_BYTES)
    throw new RangeError(`a sealed key must be 1 to ${SEALED_KEY_MAX_BYTES} bytes`);
}
