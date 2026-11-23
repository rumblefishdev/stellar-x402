import { beforeEach, describe, expect, it } from "vitest";
import {
  assertApiKey,
  assertSealedKey,
  type ApiKeyRecord,
  type ApiKeyStore,
  type OwnerKeys,
  type SealedKeyStore,
} from "../src/index.js";

/**
 * Both stores in memory, on one set of keys, for tests of what uses them. It passes the same
 * contracts as the PostgreSQL adapters.
 */
export class MemoryKeyStore implements ApiKeyStore, SealedKeyStore {
  private readonly keys: ApiKeyRecord[] = [];
  private readonly copies = new Map<string, Buffer>();

  ownerOf(hash: string): Promise<string | undefined> {
    return Promise.resolve(
      this.keys.find((key) => key.hash === hash && key.state === "active")?.owner,
    );
  }

  issue(key: { hash: string; owner: string; sealed?: Buffer; now: number }): Promise<boolean> {
    try {
      assertApiKey(key.hash, key.owner);
      if (key.sealed !== undefined) assertSealedKey(key.sealed);
      if (this.keys.some((held) => held.hash === key.hash))
        throw new Error("the registry holds this hash");
    } catch (error) {
      return Promise.reject(error as Error);
    }
    if (this.active(key.owner)) return Promise.resolve(false);
    this.keys.push({ hash: key.hash, owner: key.owner, state: "active", createdAt: key.now });
    if (key.sealed !== undefined) this.copies.set(key.hash, Buffer.from(key.sealed));
    return Promise.resolve(true);
  }

  revoke(owner: string, now: number): Promise<boolean> {
    // As PostgreSQL's: revoke, then delete the copies of the owner's revoked keys only.
    const active = this.active(owner);
    if (active) {
      active.state = "revoked";
      active.revokedAt = now;
    }
    for (const key of this.keys)
      if (key.owner === owner && key.state === "revoked") this.copies.delete(key.hash);
    return Promise.resolve(active !== undefined);
  }

  list(): Promise<ApiKeyRecord[]> {
    return Promise.resolve(
      this.keys
        .map((key) => ({ ...key }))
        .sort((a, b) => a.createdAt - b.createdAt || a.hash.localeCompare(b.hash)),
    );
  }

  keysOf(owner: string): Promise<OwnerKeys> {
    const keys: OwnerKeys = {};
    for (const key of this.keys.filter((held) => held.owner === owner)) {
      if (key.state === "active") {
        const sealed = this.copies.get(key.hash);
        keys.active = { hash: key.hash, createdAt: key.createdAt, ...(sealed && { sealed }) };
      } else {
        keys.lastRevokedAt = Math.max(keys.lastRevokedAt ?? 0, key.revokedAt ?? 0);
      }
    }
    return Promise.resolve(keys);
  }

  private active(owner: string): ApiKeyRecord | undefined {
    return this.keys.find((key) => key.owner === owner && key.state === "active");
  }
}

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

/**
 * Behaviour every `SealedKeyStore` must have, beside the registry it writes. `make` must return
 * the two on one empty set of keys.
 */
export function sealedKeyStoreContract(
  make: () =>
    | { registry: ApiKeyStore; sealed: SealedKeyStore }
    | Promise<{ registry: ApiKeyStore; sealed: SealedKeyStore }>,
) {
  describe("SealedKeyStore contract (0106)", () => {
    const HASH_A = "a".repeat(64);
    const HASH_B = "b".repeat(64);
    const COPY_A = Buffer.from("sealed copy of a");
    const COPY_B = Buffer.from("sealed copy of b");
    const OWNER = "discord:412345678901234567";
    let registry: ApiKeyStore;
    let store: SealedKeyStore;
    beforeEach(async () => {
      ({ registry, sealed: store } = await make());
    });

    it("has nothing for an owner the registry never saw", async () => {
      expect(await store.keysOf(OWNER)).toEqual({});
    });

    it("issues a key the registry knows, and keeps its copy", async () => {
      expect(await store.issue({ hash: HASH_A, owner: OWNER, sealed: COPY_A, now: 1_000 })).toBe(
        true,
      );
      expect(await registry.ownerOf(HASH_A)).toBe(OWNER);
      expect(await store.keysOf(OWNER)).toEqual({
        active: { hash: HASH_A, createdAt: 1_000, sealed: COPY_A },
      });
      expect(await store.keysOf("discord:1")).toEqual({});
    });

    it("gives an owner one active key: a second is refused, and the first copy stays", async () => {
      await store.issue({ hash: HASH_A, owner: OWNER, sealed: COPY_A, now: 1_000 });
      expect(await store.issue({ hash: HASH_B, owner: OWNER, sealed: COPY_B, now: 2_000 })).toBe(
        false,
      );
      expect(await registry.ownerOf(HASH_B)).toBeUndefined();
      expect((await store.keysOf(OWNER)).active).toEqual({
        hash: HASH_A,
        createdAt: 1_000,
        sealed: COPY_A,
      });
    });

    it("gives two concurrent issues for one owner to exactly one, with that one's copy", async () => {
      const issued = await Promise.all(
        (
          [
            [HASH_A, COPY_A],
            [HASH_B, COPY_B],
          ] as const
        ).map(([hash, sealed]) => store.issue({ hash, owner: OWNER, sealed, now: 1_000 })),
      );
      expect(issued.filter(Boolean)).toHaveLength(1);
      const { active } = await store.keysOf(OWNER);
      expect(active?.sealed).toEqual(issued[0] ? COPY_A : COPY_B);
      expect(active?.hash).toBe(issued[0] ? HASH_A : HASH_B);
      expect(await registry.list()).toHaveLength(1);
    });

    it("revokes the key at once and keeps no copy of it", async () => {
      await store.issue({ hash: HASH_A, owner: OWNER, sealed: COPY_A, now: 1_000 });
      expect(await store.revoke(OWNER, 2_000)).toBe(true);
      expect(await registry.ownerOf(HASH_A)).toBeUndefined();
      expect(await store.keysOf(OWNER)).toEqual({ lastRevokedAt: 2_000 });
      expect(await store.revoke(OWNER, 3_000)).toBe(false);
      expect(await store.revoke("discord:1", 3_000)).toBe(false);
    });

    it("issues a new key after a revoke, and remembers the last revocation", async () => {
      await store.issue({ hash: HASH_A, owner: OWNER, sealed: COPY_A, now: 1_000 });
      await store.revoke(OWNER, 2_000);
      expect(await store.issue({ hash: HASH_B, owner: OWNER, sealed: COPY_B, now: 3_000 })).toBe(
        true,
      );
      expect(await store.keysOf(OWNER)).toEqual({
        active: { hash: HASH_B, createdAt: 3_000, sealed: COPY_B },
        lastRevokedAt: 2_000,
      });
      await store.revoke(OWNER, 4_000);
      expect(await store.keysOf(OWNER)).toEqual({ lastRevokedAt: 4_000 });
    });

    it("shows a key the registry issued without a copy as active, with none", async () => {
      await registry.issue({ hash: HASH_A, owner: OWNER, now: 1_000 });
      expect(await store.keysOf(OWNER)).toEqual({ active: { hash: HASH_A, createdAt: 1_000 } });
      expect(await store.issue({ hash: HASH_B, owner: OWNER, sealed: COPY_B, now: 2_000 })).toBe(
        false,
      );
    });

    it("never shows the copy of a key the registry revoked, and issues over it", async () => {
      await store.issue({ hash: HASH_A, owner: OWNER, sealed: COPY_A, now: 1_000 });
      await registry.revoke(OWNER, 2_000);
      expect(await store.keysOf(OWNER)).toEqual({ lastRevokedAt: 2_000 });
      expect(await store.issue({ hash: HASH_B, owner: OWNER, sealed: COPY_B, now: 3_000 })).toBe(
        true,
      );
      expect((await store.keysOf(OWNER)).active?.sealed).toEqual(COPY_B);
    });

    it("stores neither half when the hash is one the registry holds", async () => {
      await store.issue({ hash: HASH_A, owner: OWNER, sealed: COPY_A, now: 1_000 });
      await expect(
        store.issue({ hash: HASH_A, owner: "discord:1", sealed: COPY_B, now: 2_000 }),
      ).rejects.toThrow();
      expect(await store.keysOf("discord:1")).toEqual({});
      expect((await store.keysOf(OWNER)).active?.sealed).toEqual(COPY_A);
    });

    it.each([
      [
        "a hash that is not 64 hex digits",
        { hash: "x402_plain-key", owner: OWNER, sealed: COPY_A },
      ],
      ["an owner with a space", { hash: HASH_A, owner: "discord:1 2", sealed: COPY_A }],
      ["an empty copy", { hash: HASH_A, owner: OWNER, sealed: Buffer.alloc(0) }],
      ["a copy over 1024 bytes", { hash: HASH_A, owner: OWNER, sealed: Buffer.alloc(1025) }],
    ])("refuses %s and stores nothing", async (_name, key) => {
      await expect(store.issue({ ...key, now: 1_000 })).rejects.toThrow(RangeError);
      expect(await registry.list()).toEqual([]);
      expect(await store.keysOf(key.owner).catch(() => ({}))).toEqual({});
    });
  });
}
