import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isApiKey } from "@stellar-x402/api-keys";

/** The first byte of a sealed copy: which layout and key it was sealed with. */
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealer {
  /** The copy of `key` to store beside its registry row. */
  seal(key: string, owner: string, hash: string): Buffer;
  /**
   * The key in a copy sealed for this `owner` and `hash`, or `undefined` when it can't be opened:
   * sealed with another key, edited, cut short, or moved from another row.
   */
  open(sealed: Buffer, owner: string, hash: string): string | undefined;
}

/**
 * Seals the copy of a key the portal shows its owner again (0106 decision 3), with AES-256-GCM
 * under a key the database never holds. A dump of the database alone gives no key.
 *
 * The owner and the key's hash are authenticated with it, so a copy put in another row doesn't
 * open there. A copy is the version byte, a random nonce, the ciphertext and the tag.
 */
export function sealer(
  encryptionKey: Buffer,
  random: (bytes: number) => Buffer = randomBytes,
): Sealer {
  const bound = (owner: string, hash: string) =>
    Buffer.from(`x402-portal/key/v${VERSION}\n${owner}\n${hash}`, "utf8");

  return {
    seal(key, owner, hash) {
      const nonce = random(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(bound(owner, hash));
      const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
    },
    open(sealed, owner, hash) {
      if (sealed.length <= 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== VERSION) return undefined;
      const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
      const ciphertext = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      decipher.setAAD(bound(owner, hash));
      decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
      try {
        const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        return isApiKey(key) ? key : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
