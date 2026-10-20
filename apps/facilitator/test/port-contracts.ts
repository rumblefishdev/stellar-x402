import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HashConflictError,
  type CatalogEntry,
  type CatalogStore,
  type NewSettlement,
  type RateLimitStore,
  type SettlementKey,
  type SettlementStore,
  type SpendLimit,
  type SpendStore,
} from "../src/ports/index.js";

/**
 * Behaviour every adapter of the four ports must have (AD-6, AD-7, AD-11, AD-16 to AD-20). The
 * in-memory adapters run these in `memory.test.ts`, the PostgreSQL adapters in `postgres.test.ts`.
 * `make` must return an empty store.
 */
type Make<T> = () => T | Promise<T>;

/** The largest stroop amount a durable store's int64 column holds. */
const INT64_MAX = 2n ** 63n - 1n;

const PAYER = "GPAYER";
const PAY_TO = "GPAYTO";

const requirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CASSET",
  amount: "100",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {},
  ...overrides,
});

export function settlement(
  nonce: string,
  network: StellarNetwork = "stellar:testnet",
): NewSettlement {
  const accepted = requirements({ network });
  const paymentPayload: PaymentPayload = { x402Version: 2, accepted, payload: { tx: "AAAA" } };
  return {
    key: `${network}:${PAYER}:${nonce}` as SettlementKey,
    network,
    payer: PAYER,
    nonce,
    fingerprint: `fp-${nonce}`,
    paymentPayload,
    paymentRequirements: accepted,
    createdAt: 1_000,
  };
}

export function settlementStoreContract(make: Make<SettlementStore>) {
  describe("SettlementStore contract", () => {
    let store: SettlementStore;
    beforeEach(async () => {
      store = await make();
    });

    it("claims a key once, also under concurrent claims", async () => {
      const s = settlement("1");
      const results = await Promise.all(Array.from({ length: 10 }, () => store.claim(s)));
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      // The whole record, so a payload or requirement that doesn't round-trip fails.
      const record = { ...s, state: "claimed", hashes: [], updatedAt: 1_000 };
      expect(results.find((r) => r.claimed)).toEqual({ claimed: true, record });
      expect(results.find((r) => !r.claimed)).toEqual({ claimed: false, existing: record });
      expect(await store.get(s.key)).toEqual(record);
    });

    it("keeps every hash, finds the record by any of them, and moves claimed to signed", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      expect(await store.addHash(key, "h1", 2_000)).toBe(true);
      expect(await store.addHash(key, "h2", 3_000)).toBe(true);
      expect(await store.addHash(key, "h2", 4_000)).toBe(true);
      // The repeat changed nothing, its time included.
      expect(await store.get(key)).toMatchObject({
        state: "signed",
        hashes: ["h1", "h2"],
        updatedAt: 3_000,
      });
      expect((await store.findByHash("h1"))?.key).toBe(key);
      expect((await store.findByHash("h2"))?.key).toBe(key);
      expect(await store.findByHash("h3")).toBeUndefined();
    });

    it("rejects a hash another record has, and changes neither record", async () => {
      const k1 = settlement("1").key;
      const k2 = settlement("2").key;
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      expect(await store.addHash(k1, "h1", 2_000)).toBe(true);
      const conflict = store.addHash(k2, "h1", 3_000);
      await expect(conflict).rejects.toBeInstanceOf(HashConflictError);
      await expect(conflict).rejects.toMatchObject({ name: "HashConflictError", hash: "h1" });
      expect(await store.get(k2)).toMatchObject({ state: "claimed", hashes: [], updatedAt: 1_000 });
      expect(await store.get(k1)).toMatchObject({
        state: "signed",
        hashes: ["h1"],
        updatedAt: 2_000,
      });
      expect((await store.findByHash("h1"))?.key).toBe(k1);
      expect(await store.addHash(k1, "h1", 4_000)).toBe(true);
      expect((await store.get(k1))?.hashes).toEqual(["h1"]);
    });

    it("gives a hash two records add concurrently to exactly one", async () => {
      const k1 = settlement("1").key;
      const k2 = settlement("2").key;
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      const results = await Promise.allSettled([
        store.addHash(k1, "h1", 2_000),
        store.addHash(k2, "h1", 2_000),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toEqual([
        { status: "fulfilled", value: true },
      ]);
      const won = results.findIndex((r) => r.status === "fulfilled");
      const lost = results[1 - won];
      expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(HashConflictError);
      const [winner, loser] = won === 0 ? [k1, k2] : [k2, k1];
      expect((await store.findByHash("h1"))?.key).toBe(winner);
      expect((await store.get(loser))?.hashes).toEqual([]);
    });

    it("refuses a hash for a missing or final record", async () => {
      const k1 = settlement("1").key;
      const k2 = settlement("2").key;
      expect(await store.addHash(k1, "h1", 2_000)).toBe(false);
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      await store.addHash(k1, "h1", 2_000);
      await store.transition(k1, "signed", { state: "success", ledger: 1, updatedAt: 3_000 });
      // A final record refuses before the hash is looked up: its own hash, or another record's.
      expect(await store.addHash(k1, "h1", 4_000)).toBe(false);
      await store.addHash(k2, "h2", 2_000);
      await store.transition(k2, "signed", {
        state: "rejected",
        errorReason: "x",
        updatedAt: 3_000,
      });
      expect(await store.addHash(k2, "h1", 4_000)).toBe(false);
    });

    it("applies a transition only from the expected state, and only forward", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.addHash(key, "h1", 2_000);
      expect(await store.transition(key, "claimed", { state: "pending", updatedAt: 3_000 })).toBe(
        undefined,
      );
      // The same state isn't a move: it would let two callers both win.
      expect(
        await store.transition(key, "signed", { state: "signed", channel: "GX", updatedAt: 2_500 }),
      ).toBe(undefined);
      const pending = await store.transition(key, "signed", {
        state: "pending",
        channel: "GCHANNEL",
        updatedAt: 3_000,
      });
      expect(pending).toMatchObject({ state: "pending", channel: "GCHANNEL", hashes: ["h1"] });
      expect(await store.transition(key, "pending", { state: "signed", updatedAt: 4_000 })).toBe(
        undefined,
      );
      const success = await store.transition(key, "pending", {
        state: "success",
        ledger: 42,
        feeCharged: 41_000n,
        updatedAt: 5_000,
      });
      expect(success).toMatchObject({ state: "success", ledger: 42, feeCharged: 41_000n });
      expect(await store.get(key)).toMatchObject({ state: "success", feeCharged: 41_000n });
    });

    it("clears a field a transition gives as undefined", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.transition(key, "claimed", { state: "signed", channel: "GA", updatedAt: 2_000 });
      const pending = await store.transition(key, "signed", {
        state: "pending",
        channel: undefined,
        updatedAt: 3_000,
      });
      expect(pending?.state).toBe("pending");
      expect(pending?.channel).toBeUndefined();
      expect((await store.get(key))?.channel).toBeUndefined();
    });

    it("keeps a field a transition omits", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.transition(key, "claimed", { state: "signed", channel: "GA", updatedAt: 2_000 });
      const pending = await store.transition(key, "signed", { state: "pending", updatedAt: 3_000 });
      expect(pending?.channel).toBe("GA");
      expect((await store.get(key))?.channel).toBe("GA");
    });

    it("lets exactly one of several concurrent transitions from a state win", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.addHash(key, "h1", 2_000);
      const results = await Promise.all(
        ["GA", "GB", "GC"].map((channel) =>
          store.transition(key, "signed", { state: "pending", channel, updatedAt: 3_000 }),
        ),
      );
      const winners = results.filter((record) => record !== undefined);
      expect(winners).toHaveLength(1);
      expect((await store.get(key))?.channel).toBe(winners[0]?.channel);
    });

    it("never moves a record on from a final state", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.transition(key, "claimed", {
        state: "rejected",
        errorReason: "x",
        updatedAt: 2_000,
      });
      expect(await store.transition(key, "rejected", { state: "success", updatedAt: 3_000 })).toBe(
        undefined,
      );
      expect((await store.get(key))?.state).toBe("rejected");
    });

    it("keeps a fee at the int64 maximum exactly", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      const success = await store.transition(key, "claimed", {
        state: "success",
        ledger: 1,
        feeCharged: INT64_MAX,
        updatedAt: 2_000,
      });
      expect(success?.feeCharged).toBe(INT64_MAX);
      expect((await store.get(key))?.feeCharged).toBe(INT64_MAX);
    });

    it("rejects a fee that isn't a non-negative int64, and leaves the record", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      for (const feeCharged of [-1n, INT64_MAX + 1n])
        await expect(
          store.transition(key, "claimed", { state: "success", feeCharged, updatedAt: 2_000 }),
        ).rejects.toBeInstanceOf(RangeError);
      expect(await store.get(key)).toMatchObject({ state: "claimed", updatedAt: 1_000 });
    });

    it("returns copies, not live state", async () => {
      const { key } = settlement("1");
      const claimed = await store.claim(settlement("1"));
      if (claimed.claimed) claimed.record.hashes.push("mutated");
      const record = await store.get(key);
      record?.hashes.push("mutated");
      expect((await store.get(key))?.hashes).toEqual([]);
    });

    it("lists non-final records of one network", async () => {
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      await store.claim(settlement("3", "stellar:pubnet"));
      await store.transition(settlement("2").key, "claimed", {
        state: "expired",
        updatedAt: 2_000,
      });
      const open = await store.listNonFinal("stellar:testnet");
      expect(open.map((r) => r.nonce)).toEqual(["1"]);
    });

    it("adds a hash to a pending record, and lists in-flight records with their hashes", async () => {
      const k1 = settlement("1").key;
      const k2 = settlement("2").key;
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      await store.addHash(k1, "h1", 2_000);
      await store.transition(k1, "signed", { state: "pending", updatedAt: 3_000 });
      // A rebuilt transaction (a fee bump) adds a hash while the record is pending.
      expect(await store.addHash(k1, "h2", 4_000)).toBe(true);
      expect(await store.get(k1)).toMatchObject({ state: "pending", hashes: ["h1", "h2"] });
      await store.addHash(k2, "h3", 2_000);
      const open = (await store.listNonFinal("stellar:testnet")).sort((a, b) =>
        a.nonce.localeCompare(b.nonce),
      );
      expect(open.map((r) => [r.nonce, r.state, r.hashes])).toEqual([
        ["1", "pending", ["h1", "h2"]],
        ["2", "signed", ["h3"]],
      ]);
    });

    describe("channel lease", () => {
      const NAME = "stellar:testnet:channels";

      it("gives the lease to one holder until it expires", async () => {
        expect(await store.acquireLease(NAME, "a", 1_000, 0)).toEqual({
          name: NAME,
          holder: "a",
          expiresAt: 1_000,
        });
        expect(await store.acquireLease(NAME, "b", 1_000, 500)).toBeUndefined();
        expect(await store.acquireLease(NAME, "b", 1_000, 1_000)).toBeUndefined();
        expect(await store.acquireLease(NAME, "b", 1_000, 1_001)).toMatchObject({ holder: "b" });
      });

      it("lets the holder take it again and renew it while it is valid", async () => {
        await store.acquireLease(NAME, "a", 1_000, 0);
        expect(await store.acquireLease(NAME, "a", 1_000, 500)).toMatchObject({ expiresAt: 1_500 });
        expect(await store.renewLease(NAME, "a", 1_000, 1_500)).toBe(true);
        expect(await store.acquireLease(NAME, "b", 1_000, 2_000)).toBeUndefined();
      });

      it("refuses to renew an expired lease or someone else's", async () => {
        expect(await store.renewLease(NAME, "a", 1_000, 0)).toBe(false);
        await store.acquireLease(NAME, "a", 1_000, 0);
        expect(await store.renewLease(NAME, "b", 1_000, 500)).toBe(false);
        expect(await store.renewLease(NAME, "a", 1_000, 1_001)).toBe(false);
      });

      it("gives a contested lease to exactly one holder", async () => {
        const leases = await Promise.all(
          Array.from({ length: 10 }, (_, i) => store.acquireLease(NAME, `h${i}`, 1_000, 0)),
        );
        const winners = leases.filter((lease) => lease !== undefined);
        expect(winners).toHaveLength(1);
        expect(await store.renewLease(NAME, winners[0]!.holder, 1_000, 500)).toBe(true);
      });

      it("gives an expired, contested lease to exactly one holder", async () => {
        await store.acquireLease(NAME, "a", 1_000, 0);
        const leases = await Promise.all(
          Array.from({ length: 10 }, (_, i) => store.acquireLease(NAME, `h${i}`, 1_000, 1_001)),
        );
        expect(leases.filter((lease) => lease !== undefined)).toHaveLength(1);
      });

      it("releases only for the holder", async () => {
        await store.acquireLease(NAME, "a", 1_000, 0);
        await store.releaseLease(NAME, "b");
        expect(await store.acquireLease(NAME, "b", 1_000, 100)).toBeUndefined();
        await store.releaseLease(NAME, "a");
        expect(await store.acquireLease(NAME, "b", 1_000, 100)).toMatchObject({ holder: "b" });
      });
    });
  });
}

export function spendStoreContract(make: Make<SpendStore>) {
  describe("SpendStore contract", () => {
    let store: SpendStore;
    beforeEach(async () => {
      store = await make();
    });

    const DAY = 86_400_000;
    const limits = (global: bigint, perPayer = 1_000n): SpendLimit[] => [
      { scope: "global", maxStroops: global, windowMs: DAY },
      { scope: `payer:${PAYER}`, maxStroops: perPayer, windowMs: DAY },
    ];

    it("reserves against every limit, or against none", async () => {
      expect(await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 })).toEqual({
        reserved: true,
      });
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 1 })).toEqual({
        reserved: false,
        scope: "global",
      });
      expect(await store.used(`payer:${PAYER}`, DAY, 1)).toBe(60n);
      expect(
        await store.reserve({ id: "c", amount: 30n, limits: limits(1_000n, 80n), now: 2 }),
      ).toEqual({ reserved: false, scope: `payer:${PAYER}` });
      expect(await store.used("global", DAY, 2)).toBe(60n);
    });

    it("never goes over a limit under concurrent reservations", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.reserve({ id: `r${i}`, amount: 30n, limits: limits(100n), now: 0 }),
        ),
      );
      expect(results.filter((r) => r.reserved)).toHaveLength(3);
      expect(await store.used("global", DAY, 0)).toBe(90n);
    });

    it("never goes over a limit when reservations list their scopes in different orders", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.reserve({
            id: `r${i}`,
            amount: 30n,
            limits: i % 2 ? limits(100n, 100n).reverse() : limits(100n, 100n),
            now: 0,
          }),
        ),
      );
      expect(results.filter((r) => r.reserved)).toHaveLength(3);
      expect(await store.used("global", DAY, 0)).toBe(90n);
      expect(await store.used(`payer:${PAYER}`, DAY, 0)).toBe(90n);
    });

    it("reserves an amount at the int64 maximum exactly", async () => {
      expect(
        await store.reserve({
          id: "a",
          amount: INT64_MAX,
          limits: limits(INT64_MAX, INT64_MAX),
          now: 0,
        }),
      ).toEqual({ reserved: true });
      expect(await store.used("global", DAY, 0)).toBe(INT64_MAX);
      expect(await store.used(`payer:${PAYER}`, DAY, 0)).toBe(INT64_MAX);
      expect(
        await store.reserve({ id: "b", amount: 1n, limits: limits(INT64_MAX, INT64_MAX), now: 0 }),
      ).toEqual({ reserved: false, scope: "global" });
    });

    it("rejects a stroop amount that isn't a non-negative int64, and changes nothing", async () => {
      for (const bad of [-1n, INT64_MAX + 1n]) {
        await expect(
          store.reserve({ id: "a", amount: bad, limits: limits(100n), now: 0 }),
        ).rejects.toBeInstanceOf(RangeError);
        const limit = { scope: "global" as const, maxStroops: bad, windowMs: DAY };
        await expect(
          store.reserve({ id: "a", amount: 1n, limits: [limit], now: 0 }),
        ).rejects.toBeInstanceOf(RangeError);
      }
      expect(await store.used("global", DAY, 0)).toBe(0n);
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await expect(store.commit("a", -1n, 10)).rejects.toBeInstanceOf(RangeError);
      expect(await store.used("global", DAY, 10)).toBe(60n);
    });

    it("treats a repeated id as a no-op", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 1 })).toEqual({
        reserved: true,
      });
      expect(await store.used("global", DAY, 1)).toBe(60n);
    });

    it("reserves a previously rejected id once budget frees up", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 1 })).toEqual({
        reserved: false,
        scope: "global",
      });
      await store.release("a");
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 2 })).toEqual({
        reserved: true,
      });
      expect(await store.used("global", DAY, 2)).toBe(60n);
    });

    it("counts a reservation stamped after now", async () => {
      // A caller takes `now` before waiting on the scope lock, so a later stamp can win it first.
      await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 1_001 });
      expect(
        await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 1_000 }),
      ).toEqual({ reserved: false, scope: "global" });
      expect(await store.used("global", DAY, 1_000)).toBe(60n);
    });

    it("commits the fee actually paid and releases what was never spent", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await store.reserve({ id: "b", amount: 30n, limits: limits(100n), now: 0 });
      await store.commit("a", 20n, 10);
      await store.release("b");
      expect(await store.used("global", DAY, 10)).toBe(20n);
      // The commit stamped the fee at 10, so it outlives the reservation's window.
      expect(await store.used("global", DAY, DAY + 5)).toBe(20n);
    });

    it("keeps a committed fee through a release, and reports a commit of an unknown id", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.commit("a", 20n, 10)).toBe(true);
      // The fee was paid on-chain; a late release (a timed-out path) can't hand it back.
      await store.release("a");
      expect(await store.used("global", DAY, 10)).toBe(20n);
      expect(await store.commit("missing", 20n, 10)).toBe(false);
      expect(await store.used("global", DAY, 10)).toBe(20n);
    });

    it("counts only the rolling window", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.used("global", DAY, DAY - 1)).toBe(60n);
      expect(await store.used("global", DAY, DAY)).toBe(0n);
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: DAY })).toEqual(
        { reserved: true },
      );
    });

    it("counts each scope on its own, and only the scopes a reservation lists", async () => {
      const payer = (name: string): SpendLimit[] => [
        { scope: `payer:${name}`, maxStroops: 100n, windowMs: DAY },
      ];
      await store.reserve({ id: "a", amount: 80n, limits: payer("A"), now: 0 });
      expect(await store.reserve({ id: "b", amount: 80n, limits: payer("B"), now: 0 })).toEqual({
        reserved: true,
      });
      expect(await store.used("payer:A", DAY, 0)).toBe(80n);
      expect(await store.used("payer:B", DAY, 0)).toBe(80n);
      expect(await store.used("global", DAY, 0)).toBe(0n);
    });

    it("keeps each scope's failures and breaker apart", async () => {
      const [x, y] = ["asset:CX", "asset:CY"] as const;
      await store.recordFailure(x, 0);
      await store.recordFailure(x, 1);
      expect(await store.recordFailure(y, 2)).toBe(1);
      await store.recordSuccess(y);
      expect(await store.recordFailure(x, 3)).toBe(3);
      await store.openBreaker(x, 1_000);
      expect(await store.breakerOpenUntil(y, 0)).toBeUndefined();
      expect(await store.breakerOpenUntil(x, 0)).toBe(1_000);
    });

    it("counts consecutive failures and opens a breaker until a time", async () => {
      const scope = "asset:CASSET" as const;
      expect(await store.recordFailure(scope, 0)).toBe(1);
      expect(await store.recordFailure(scope, 1)).toBe(2);
      await store.recordSuccess(scope);
      expect(await store.recordFailure(scope, 2)).toBe(1);
      expect(await store.breakerOpenUntil(scope, 0)).toBeUndefined();
      await store.openBreaker(scope, 1_000);
      expect(await store.breakerOpenUntil(scope, 999)).toBe(1_000);
      expect(await store.breakerOpenUntil(scope, 1_000)).toBeUndefined();
    });

    it("keeps the later end when a breaker is opened again", async () => {
      const scope = "asset:CASSET" as const;
      await store.openBreaker(scope, 2_000);
      // Another task opening it with an earlier end can't close it early.
      await store.openBreaker(scope, 1_000);
      expect(await store.breakerOpenUntil(scope, 1_500)).toBe(2_000);
      await store.openBreaker(scope, 3_000);
      expect(await store.breakerOpenUntil(scope, 2_500)).toBe(3_000);
    });
  });
}

export function rateLimitStoreContract(make: Make<RateLimitStore>) {
  describe("RateLimitStore contract", () => {
    let store: RateLimitStore;
    beforeEach(async () => {
      store = await make();
    });

    it("counts hits per key in fixed windows", async () => {
      expect(await store.hit("settle:ip:1", 60_000, 1_000)).toEqual({ count: 1, resetAt: 60_000 });
      expect(await store.hit("settle:ip:1", 60_000, 59_999)).toEqual({ count: 2, resetAt: 60_000 });
      expect(await store.hit("settle:ip:2", 60_000, 2_000)).toEqual({ count: 1, resetAt: 60_000 });
      expect(await store.hit("settle:ip:1", 60_000, 60_000)).toEqual({
        count: 1,
        resetAt: 120_000,
      });
    });

    it("counts a hit from an older window in the stored one", async () => {
      expect(await store.hit("k", 60_000, 60_000)).toEqual({ count: 1, resetAt: 120_000 });
      expect(await store.hit("k", 60_000, 59_999)).toEqual({ count: 2, resetAt: 120_000 });
    });

    it("counts concurrent hits exactly", async () => {
      await Promise.all(Array.from({ length: 10 }, () => store.hit("k", 60_000, 0)));
      expect(await store.hit("k", 60_000, 0)).toEqual({ count: 11, resetAt: 60_000 });
    });
  });
}

export function catalogStoreContract(make: Make<CatalogStore>) {
  describe("CatalogStore contract", () => {
    let store: CatalogStore;
    beforeEach(async () => {
      store = await make();
    });

    const resource = (
      url: string,
      overrides: Partial<DiscoveryResource> = {},
    ): DiscoveryResource => ({
      resource: url,
      type: "http",
      x402Version: 2,
      accepts: [requirements()],
      lastUpdated: "2026-10-08T00:00:00.000Z",
      ...overrides,
    });
    const upsert = (entry: Omit<CatalogEntry, "keyVersion" | "ledger">, ledger = 1) =>
      store.upsert({ keyVersion: CATALOG_KEY_VERSION, ledger, ...entry });
    const key = (url: string, payTo = PAY_TO, network: StellarNetwork = "stellar:testnet") => ({
      network,
      payTo,
      method: "GET",
      resourceUrl: url,
    });

    it("upserts by key, merging accepts by scheme, network and asset", async () => {
      const url = "https://seller.example/data";
      await upsert({ key: key(url), resource: resource(url, { description: "old" }) });
      await upsert({
        key: key(url),
        resource: resource(url, {
          description: "new",
          accepts: [requirements({ asset: "COTHER" })],
          lastUpdated: "2026-10-09T00:00:00.000Z",
        }),
      });
      await upsert({
        key: key(url),
        resource: resource(url, { description: "new", accepts: [requirements({ amount: "200" })] }),
      });
      const page = await store.list({ limit: 10, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({ description: "new" });
      expect(page.items[0]?.accepts.map((a) => [a.asset, a.amount])).toEqual([
        ["CASSET", "200"],
        ["COTHER", "100"],
      ]);
    });

    it("reports the outcome; a write from an earlier ledger only adds what is missing", async () => {
      const url = "https://seller.example/data";
      const at = (ledger: number, description: string, asset = "CASSET") =>
        upsert(
          {
            key: key(url),
            resource: resource(url, {
              description,
              accepts: [requirements({ asset, amount: String(ledger) })],
            }),
          },
          ledger,
        );
      expect(await at(10, "new")).toBe("inserted");
      expect(await at(10, "same ledger")).toBe("updated");
      expect(await at(9, "old", "COTHER")).toBe("stale");
      expect(await at(9, "old")).toBe("stale");
      const [item] = (await store.list({ limit: 10, offset: 0 })).items;
      expect(item?.description).toBe("same ledger");
      expect(item?.accepts.map((a) => [a.asset, a.amount])).toEqual([
        ["CASSET", "10"],
        ["COTHER", "9"],
      ]);
      await expect(at(Number.NaN, "bad")).rejects.toThrow();
    });

    it("merges concurrent upserts of one key without losing a requirement", async () => {
      const url = "https://seller.example/data";
      const assets = Array.from({ length: 10 }, (_, i) => `C${i}`);
      await Promise.all(
        assets.map((asset) =>
          upsert({
            key: key(url),
            resource: resource(url, { accepts: [requirements({ asset })] }),
          }),
        ),
      );
      const page = await store.list({ limit: 10, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.items[0]?.accepts.map((a) => a.asset).sort()).toEqual(assets.sort());
    });

    it("filters, pages and keeps a stable order", async () => {
      await upsert({
        key: key("https://a.example"),
        resource: resource("https://a.example"),
      });
      await upsert({
        key: key("https://b.example", "GOTHER"),
        resource: resource("https://b.example", {
          type: "mcp",
          extensions: { bazaar: {}, unset: undefined },
        }),
      });
      await upsert({
        key: key("https://c.example", PAY_TO, "stellar:pubnet"),
        resource: resource("https://c.example"),
      });
      // An update keeps the entry's place in the order.
      await upsert({
        key: key("https://a.example"),
        resource: resource("https://a.example"),
      });

      const urls = async (query: Parameters<CatalogStore["list"]>[0]) =>
        (await store.list(query)).items.map((item) => item.resource);
      expect(await urls({ limit: 10, offset: 0 })).toEqual([
        "https://a.example",
        "https://b.example",
        "https://c.example",
      ]);
      expect(await urls({ type: "mcp", limit: 10, offset: 0 })).toEqual(["https://b.example"]);
      expect(await urls({ payTo: PAY_TO, limit: 10, offset: 0 })).toEqual([
        "https://a.example",
        "https://c.example",
      ]);
      expect(await urls({ network: "stellar:pubnet", limit: 10, offset: 0 })).toEqual([
        "https://c.example",
      ]);
      expect(await urls({ extensions: "bazaar", limit: 10, offset: 0 })).toEqual([
        "https://b.example",
      ]);
      // The value comes from the query string: a key from Object's prototype matches nothing, and
      // neither does a key without a value (JSON storage drops it).
      expect(await urls({ extensions: "constructor", limit: 10, offset: 0 })).toEqual([]);
      expect(await urls({ extensions: "unset", limit: 10, offset: 0 })).toEqual([]);
      const page = await store.list({ limit: 1, offset: 1 });
      expect(page).toMatchObject({ total: 3, items: [{ resource: "https://b.example" }] });
      expect(await store.list({ limit: 10, offset: 5 })).toEqual({ items: [], total: 3 });
    });

    it("filters on the stored fields after an update, and after a stale write", async () => {
      const url = "https://seller.example/data";
      const at = (ledger: number, overrides: Partial<DiscoveryResource>) =>
        upsert({ key: key(url), resource: resource(url, overrides) }, ledger);
      await at(10, { type: "http", extensions: { bazaar: {} } });
      await at(10, { type: "mcp" });
      // A write from an earlier ledger keeps the stored fields, and with them the filters.
      expect(await at(9, { type: "http", extensions: { bazaar: {} } })).toBe("stale");
      const total = async (query: Omit<Parameters<CatalogStore["list"]>[0], "limit" | "offset">) =>
        (await store.list({ ...query, limit: 10, offset: 0 })).total;
      expect(await total({ type: "mcp" })).toBe(1);
      expect(await total({ type: "http" })).toBe(0);
      expect(await total({ extensions: "bazaar" })).toBe(0);
    });

    it("matches an extension only as an object's key, not an array element or a string", async () => {
      const entries = [
        ["https://object.example", { bazaar: {} }],
        ["https://array.example", ["bazaar"]],
        ["https://string.example", "bazaar"],
      ] as const;
      for (const [url, extensions] of entries)
        await upsert({
          key: key(url),
          resource: resource(url, {
            extensions: extensions as unknown as DiscoveryResource["extensions"],
          }),
        });
      const page = await store.list({ extensions: "bazaar", limit: 10, offset: 0 });
      expect(page.items.map((item) => item.resource)).toEqual(["https://object.example"]);
      expect(page.total).toBe(1);
      // An array's index is not an extension key either.
      expect(await store.list({ extensions: "0", limit: 10, offset: 0 })).toEqual({
        items: [],
        total: 0,
      });
    });
  });
}
