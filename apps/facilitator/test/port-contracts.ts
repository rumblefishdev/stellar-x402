import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CatalogStore,
  NewSettlement,
  RateLimitStore,
  SettlementKey,
  SettlementStore,
  SpendLimit,
  SpendStore,
} from "../src/ports/index.js";

/**
 * Behaviour every adapter of the four ports must have (AD-6, AD-7, AD-11, AD-16 to AD-20). The
 * in-memory adapters run these in `memory.test.ts`; the durable adapters (0022) run the same
 * suites. `make` must return an empty store.
 */
type Make<T> = () => T | Promise<T>;

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

function settlement(nonce: string, network = "stellar:testnet" as const): NewSettlement {
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
      const lost = results.find((r) => !r.claimed);
      expect(lost).toMatchObject({ claimed: false, existing: { key: s.key, fingerprint: "fp-1" } });
      expect(await store.get(s.key)).toMatchObject({
        state: "claimed",
        hashes: [],
        updatedAt: 1_000,
      });
    });

    it("keeps every hash, finds the record by any of them, and moves claimed to signed", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      expect(await store.addHash(key, "h1", 2_000)).toBe(true);
      expect(await store.addHash(key, "h2", 3_000)).toBe(true);
      expect(await store.addHash(key, "h2", 4_000)).toBe(true);
      expect(await store.get(key)).toMatchObject({ state: "signed", hashes: ["h1", "h2"] });
      expect((await store.findByHash("h1"))?.key).toBe(key);
      expect((await store.findByHash("h2"))?.key).toBe(key);
      expect(await store.findByHash("h3")).toBeUndefined();
    });

    it("refuses a hash for a missing or final record", async () => {
      const { key } = settlement("1");
      expect(await store.addHash(key, "h1", 2_000)).toBe(false);
      await store.claim(settlement("1"));
      await store.transition(key, "claimed", {
        state: "rejected",
        errorReason: "x",
        updatedAt: 2_000,
      });
      expect(await store.addHash(key, "h1", 3_000)).toBe(false);
    });

    it("applies a transition only from the expected state, and only forward", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.addHash(key, "h1", 2_000);
      expect(await store.transition(key, "claimed", { state: "pending", updatedAt: 3_000 })).toBe(
        undefined,
      );
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
      await store.claim(settlement("3", "stellar:pubnet" as "stellar:testnet"));
      await store.transition(settlement("2").key, "claimed", {
        state: "expired",
        updatedAt: 2_000,
      });
      const open = await store.listNonFinal("stellar:testnet");
      expect(open.map((r) => r.nonce)).toEqual(["1"]);
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

    it("treats a repeated id as a no-op", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 1 })).toEqual({
        reserved: true,
      });
      expect(await store.used("global", DAY, 1)).toBe(60n);
    });

    it("commits the fee actually paid and releases what was never spent", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await store.reserve({ id: "b", amount: 30n, limits: limits(100n), now: 0 });
      await store.commit("a", 20n, 10);
      await store.release("b");
      expect(await store.used("global", DAY, 10)).toBe(20n);
    });

    it("counts only the rolling window ending at now", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.used("global", DAY, DAY - 1)).toBe(60n);
      expect(await store.used("global", DAY, DAY)).toBe(0n);
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: DAY })).toEqual(
        { reserved: true },
      );
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
    const key = (url: string, payTo = PAY_TO, network = "stellar:testnet" as const) => ({
      network,
      payTo,
      method: "GET",
      resourceUrl: url,
    });

    it("upserts by key, merging accepts by scheme, network and asset", async () => {
      const url = "https://seller.example/data";
      await store.upsert({ key: key(url), resource: resource(url, { description: "old" }) });
      await store.upsert({
        key: key(url),
        resource: resource(url, {
          description: "new",
          accepts: [requirements({ asset: "COTHER" })],
          lastUpdated: "2026-10-09T00:00:00.000Z",
        }),
      });
      await store.upsert({
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

    it("filters, pages and keeps a stable order", async () => {
      await store.upsert({
        key: key("https://a.example"),
        resource: resource("https://a.example"),
      });
      await store.upsert({
        key: key("https://b.example", "GOTHER"),
        resource: resource("https://b.example", { type: "mcp", extensions: { bazaar: {} } }),
      });
      await store.upsert({
        key: key("https://c.example", PAY_TO, "stellar:pubnet" as "stellar:testnet"),
        resource: resource("https://c.example"),
      });
      // An update keeps the entry's place in the order.
      await store.upsert({
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
      const page = await store.list({ limit: 1, offset: 1 });
      expect(page).toMatchObject({ total: 3, items: [{ resource: "https://b.example" }] });
    });
  });
}
