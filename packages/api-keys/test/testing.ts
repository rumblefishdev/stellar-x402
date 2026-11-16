import { beforeEach, describe, expect, it } from "vitest";
import type { ApiKeyStore } from "../src/index.js";

/**
 * Behaviour every `ApiKeyStore` must have. `make` must return an empty store. The facilitator
 * runs it against the PostgreSQL adapter on its own schema, which this package doesn't hold.
 */
export function apiKeyStoreContract(make: () => ApiKeyStore | Promise<ApiKeyStore>) {
  describe("ApiKeyStore contract (0105)", () => {
    const HASH_A = "a".repeat(64);
    const HASH_B = "b".repeat(64);
    let store: ApiKeyStore;
    beforeEach(async () => {
      store = await make();
    });

    it("knows an issued key's owner by its hash, and no other hash", async () => {
      expect(await store.issue({ hash: HASH_A, owner: "operator:acme", now: 1_000 })).toBe(true);
      expect(await store.ownerOf(HASH_A)).toBe("operator:acme");
      expect(await store.ownerOf(HASH_B)).toBeUndefined();
    });

    it("gives an owner one active key: a second is refused and stores nothing", async () => {
      expect(await store.issue({ hash: HASH_A, owner: "operator:acme", now: 1_000 })).toBe(true);
      expect(await store.issue({ hash: HASH_B, owner: "operator:acme", now: 2_000 })).toBe(false);
      expect(await store.ownerOf(HASH_A)).toBe("operator:acme");
      expect(await store.ownerOf(HASH_B)).toBeUndefined();
      expect(await store.list()).toHaveLength(1);
      // Another owner is not held up.
      expect(await store.issue({ hash: HASH_B, owner: "operator:other", now: 2_000 })).toBe(true);
    });

    it("gives two concurrent issues for one owner to exactly one", async () => {
      const issued = await Promise.all(
        [HASH_A, HASH_B].map((hash) => store.issue({ hash, owner: "operator:acme", now: 1_000 })),
      );
      expect(issued.filter(Boolean)).toHaveLength(1);
      expect(await store.list()).toHaveLength(1);
    });

    it("revokes an owner's active key at once and keeps its row", async () => {
      await store.issue({ hash: HASH_A, owner: "operator:acme", now: 1_000 });
      expect(await store.revoke("operator:acme", 2_000)).toBe(true);
      expect(await store.ownerOf(HASH_A)).toBeUndefined();
      expect(await store.list()).toEqual([
        {
          hash: HASH_A,
          owner: "operator:acme",
          state: "revoked",
          createdAt: 1_000,
          revokedAt: 2_000,
        },
      ]);
      // Nothing is active any more, so a second revoke changes nothing.
      expect(await store.revoke("operator:acme", 3_000)).toBe(false);
      expect((await store.list())[0]?.revokedAt).toBe(2_000);
      expect(await store.revoke("operator:nobody", 3_000)).toBe(false);
    });

    it("issues a new key after a revoke, and the revoked one stays revoked", async () => {
      await store.issue({ hash: HASH_A, owner: "operator:acme", now: 1_000 });
      await store.revoke("operator:acme", 2_000);
      expect(await store.issue({ hash: HASH_B, owner: "operator:acme", now: 3_000 })).toBe(true);
      expect(await store.ownerOf(HASH_A)).toBeUndefined();
      expect(await store.ownerOf(HASH_B)).toBe("operator:acme");
      // Oldest first.
      expect(await store.list()).toEqual([
        {
          hash: HASH_A,
          owner: "operator:acme",
          state: "revoked",
          createdAt: 1_000,
          revokedAt: 2_000,
        },
        { hash: HASH_B, owner: "operator:acme", state: "active", createdAt: 3_000 },
      ]);
    });

    it("never takes a hash twice, whoever asks and whatever its state", async () => {
      await store.issue({ hash: HASH_A, owner: "operator:acme", now: 1_000 });
      await expect(
        store.issue({ hash: HASH_A, owner: "operator:other", now: 2_000 }),
      ).rejects.toThrow();
      await store.revoke("operator:acme", 2_000);
      await expect(
        store.issue({ hash: HASH_A, owner: "operator:acme", now: 3_000 }),
      ).rejects.toThrow();
      expect(await store.ownerOf(HASH_A)).toBeUndefined();
    });

    it.each([
      ["a hash that is not 64 hex digits", { hash: "x402_plain-key", owner: "operator:acme" }],
      ["an upper-case hash", { hash: "A".repeat(64), owner: "operator:acme" }],
      ["an empty owner", { hash: HASH_A, owner: "" }],
      ["an owner over 128 characters", { hash: HASH_A, owner: `operator:${"a".repeat(120)}` }],
      ["an owner with a space", { hash: HASH_A, owner: "operator:ac me" }],
    ])("refuses %s and stores nothing", async (_name, key) => {
      await expect(store.issue({ ...key, now: 1_000 })).rejects.toThrow(RangeError);
      expect(await store.list()).toEqual([]);
    });
  });
}
