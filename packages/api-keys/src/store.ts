/** A registry row: one key an owner was issued, active or revoked. */
export interface ApiKeyRecord {
  /** The key's SHA-256 as 64 lower-case hex digits. The key itself is stored nowhere. */
  hash: string;
  /** Who the key was issued to, see {@link ApiKeyStore}. */
  owner: string;
  state: "active" | "revoked";
  createdAt: number;
  /** Set once the key is revoked. */
  revokedAt?: number;
}

/**
 * The API key registry (0105, ADR 0007's amendment of 2026-11-03): which callers may use
 * `/verify` and `/settle` on a network that requires a key. It holds a key's hash, never the key.
 *
 * An owner is `<kind>:<id>`: `operator:<name>` for a key the operator issues by hand, and
 * `discord:<snowflake>` for one the portal issues (0106). It has at most one active key. The rate
 * limiter counts a caller by its owner and the spend policy budgets by it (0107), so a new key
 * carries its owner's counts on. A revoked key keeps its row as the record of the revocation.
 */
export interface ApiKeyStore {
  /**
   * The owner of the active key with this hash. Resolves `undefined` for a hash it doesn't know
   * and for a revoked key alike. Reads the registry on every call, so a revocation holds from the
   * next request on, on every instance.
   */
  ownerOf(hash: string): Promise<string | undefined>;
  /**
   * Stores a new active key for `owner`. Resolves `false`, storing nothing, when the owner has an
   * active key: revoke it first. Throws a `RangeError` for a hash that isn't 64 lower-case hex
   * digits or an owner that isn't `<kind>:<id>`, and rejects a hash the registry already holds in
   * any state.
   */
  issue(key: { hash: string; owner: string; now: number }): Promise<boolean>;
  /** Revokes the owner's active key. Resolves `false` when it has none. */
  revoke(owner: string, now: number): Promise<boolean>;
  /** Every key ever issued, oldest first: for the operator's script. */
  list(): Promise<ApiKeyRecord[]>;
}

/** The key an owner holds now, as its issuer sees it. */
export interface OwnedKey {
  hash: string;
  createdAt: number;
  /**
   * The key's sealed copy. Absent for a key issued without one, the operator's script's, which
   * nobody can show again.
   */
  sealed?: Buffer;
}

/** An owner's keys: the active one, when it has one, and when its last one was revoked. */
export interface OwnerKeys {
  active?: OwnedKey;
  /** When the owner's most recently revoked key was revoked. */
  lastRevokedAt?: number;
}

/**
 * The registry for an issuer that shows a key to its owner again (0106 decision 3). The registry
 * holds a key's hash only, so each key issued here is stored with a copy the issuer sealed, and
 * the copy lives as long as the key is active. The store sees neither the key nor what seals it.
 */
export interface SealedKeyStore {
  /**
   * Stores a new active key for `owner` and its sealed copy, both or neither. Resolves `false`,
   * storing nothing, when the owner has an active key. Throws a `RangeError` for what
   * {@link ApiKeyStore.issue} refuses and for a copy that is empty or over
   * {@link SEALED_KEY_MAX_BYTES}.
   */
  issue(key: { hash: string; owner: string; sealed: Buffer; now: number }): Promise<boolean>;
  /**
   * Revokes the owner's active key and deletes every copy of the owner's keys, both or neither.
   * Resolves `false` when it has no active key.
   */
  revoke(owner: string, now: number): Promise<boolean>;
  /** The owner's active key and its last revocation; `{}` for an owner the registry never saw. */
  keysOf(owner: string): Promise<OwnerKeys>;
}
