import { CATALOG_KEY_VERSION } from "@stellar-x402/bazaar";
import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HashConflictError,
  type CatalogAttempt,
  type CatalogAttemptStore,
  type CatalogKey,
  LEASE_SKEW_MARGIN_MS,
  LeaseFencedError,
  type LeaseFence,
  type CatalogEntry,
  type CatalogStore,
  type CurationStore,
  type ListedResource,
  type NewSettlement,
  type RateLimitStore,
  type CardListing,
  type SearchCardStore,
  type SettlementKey,
  type SettlementStore,
  type SpendLimit,
  type SpendStore,
} from "../src/ports/index.js";
import { QUERY_VECTOR, unitVector } from "./vectors.js";

/**
 * Behaviour every adapter of the four ports must have (AD-6, AD-7, AD-11, AD-16 to AD-20), run
 * against the PostgreSQL adapters in `postgres.test.ts`. `make` must return an empty store.
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

/**
 * A settlement of `PAYER`'s. Each nonce pays in an asset of its own unless `asset` is given, so
 * records of one payer don't wait on each other: only one per payer and asset is non-final (0024).
 */
export function settlement(
  nonce: string,
  network: StellarNetwork = "stellar:testnet",
  asset = `CASSET${nonce}`,
): NewSettlement {
  const accepted = requirements({ network, asset });
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

/** The lease `holdLease` takes, apart from any network's channel lease. */
export const TEST_LEASE_NAME = "test:channels";

/**
 * Takes a lease for the `addHash` calls of tests that aren't about the lease: every hash is stored
 * under a lease's current token (0071). Every call is a new acquire, so it draws a new token and
 * the one an earlier call returned no longer stores anything.
 */
export async function holdLease(store: Pick<SettlementStore, "acquireLease">): Promise<LeaseFence> {
  const lease = await store.acquireLease(TEST_LEASE_NAME, "test", 1e12, 0);
  if (!lease) throw new Error(`${TEST_LEASE_NAME} is held by another holder`);
  return { name: lease.name, token: lease.token };
}

export function settlementStoreContract(make: Make<SettlementStore>) {
  describe("SettlementStore contract", () => {
    let store: SettlementStore;
    let LEASE: LeaseFence;
    beforeEach(async () => {
      store = await make();
      LEASE = await holdLease(store);
    });

    it("claims a key once, also under concurrent claims", async () => {
      const s = settlement("1");
      const results = await Promise.all(Array.from({ length: 10 }, () => store.claim(s)));
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      // The whole record, so a payload or requirement that doesn't round-trip fails.
      const record = {
        ...s,
        state: "claimed",
        hashes: [],
        version: 0,
        reopened: 0,
        updatedAt: 1_000,
      };
      expect(results.find((r) => r.claimed)).toEqual({ claimed: true, record });
      expect(results.find((r) => !r.claimed)).toEqual({ claimed: false, existing: record });
      expect(await store.get(s.key)).toEqual(record);
    });

    it("returns the whole record from transition, findByHash and listNonFinal", async () => {
      const s = settlement("1");
      await store.claim(s);
      await store.addHash(s.key, "h1", LEASE, 2_000);
      const update = { state: "pending", channel: "GCHANNEL", updatedAt: 3_000 } as const;
      const pending = { ...s, ...update, hashes: ["h1"], version: 1, reopened: 0 };
      expect(await store.transition(s.key, "signed", update)).toEqual(pending);
      expect(await store.findByHash("h1")).toEqual(pending);
      expect(await store.listNonFinal("stellar:testnet")).toEqual([pending]);
    });

    it("bumps the version with each new hash, and fails a transition that expects an older one", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.addHash(key, "h1", LEASE, 2_000);
      await store.addHash(key, "h1", LEASE, 2_500);
      expect((await store.get(key))?.version).toBe(1);
      await store.addHash(key, "h2", LEASE, 3_000);
      expect((await store.get(key))?.version).toBe(2);
      const expired = { state: "expired", updatedAt: 4_000 } as const;
      // A hash appended since version 1 was read: the write fails, and the record stays open.
      expect(await store.transition(key, "signed", expired, 1)).toBeUndefined();
      expect((await store.get(key))?.state).toBe("signed");
      expect(await store.transition(key, "signed", expired, 2)).toMatchObject({
        state: "expired",
        version: 2,
      });
    });

    it("refuses a hash for a claim closed with nothing sent, so a late write can't send", async () => {
      // A sweep closes a claim with no hash by the time (reconcile, decision 13); a call's write
      // sent before that close and arriving after it must still be refused.
      const s = settlement("1");
      await store.claim(s);
      await store.transition(s.key, "claimed", {
        state: "rejected",
        errorReason: "settle_exact_stellar_interrupted",
        updatedAt: 3_000,
      });
      expect(await store.addHash(s.key, "h1", LEASE, 2_000)).toBe(false);
      expect((await store.get(s.key))?.hashes).toEqual([]);
    });

    it("lets exactly one of addHash and a versioned transition win when they race", async () => {
      for (let i = 0; i < 10; i++) {
        const s = settlement(String(i));
        await store.claim(s);
        await store.addHash(s.key, `a${i}`, LEASE, 2_000);
        const [added, ended] = await Promise.all([
          store.addHash(s.key, `b${i}`, LEASE, 3_000),
          store.transition(s.key, "signed", { state: "expired", updatedAt: 3_000 }, 1),
        ]);
        expect(added !== (ended !== undefined)).toBe(true);
      }
    });

    it("keeps every hash, finds the record by any of them, and moves claimed to signed", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      expect(await store.addHash(key, "h1", LEASE, 2_000)).toBe(true);
      expect(await store.addHash(key, "h2", LEASE, 3_000)).toBe(true);
      expect(await store.addHash(key, "h2", LEASE, 4_000)).toBe(true);
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
      expect(await store.addHash(k1, "h1", LEASE, 2_000)).toBe(true);
      const conflict = store.addHash(k2, "h1", LEASE, 3_000);
      await expect(conflict).rejects.toBeInstanceOf(HashConflictError);
      await expect(conflict).rejects.toMatchObject({ name: "HashConflictError", hash: "h1" });
      expect(await store.get(k2)).toMatchObject({ state: "claimed", hashes: [], updatedAt: 1_000 });
      expect(await store.get(k1)).toMatchObject({
        state: "signed",
        hashes: ["h1"],
        updatedAt: 2_000,
      });
      expect((await store.findByHash("h1"))?.key).toBe(k1);
      expect(await store.addHash(k1, "h1", LEASE, 4_000)).toBe(true);
      expect((await store.get(k1))?.hashes).toEqual(["h1"]);
    });

    it("gives a hash two records add concurrently to exactly one", async () => {
      const k1 = settlement("1").key;
      const k2 = settlement("2").key;
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      const results = await Promise.allSettled([
        store.addHash(k1, "h1", LEASE, 2_000),
        store.addHash(k2, "h1", LEASE, 2_000),
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
      expect(await store.addHash(k1, "h1", LEASE, 2_000)).toBe(false);
      await store.claim(settlement("1"));
      await store.claim(settlement("2"));
      await store.addHash(k1, "h1", LEASE, 2_000);
      await store.transition(k1, "signed", { state: "success", ledger: 1, updatedAt: 3_000 });
      // A final record refuses before the hash is looked up: its own hash, or another record's.
      expect(await store.addHash(k1, "h1", LEASE, 4_000)).toBe(false);
      await store.addHash(k2, "h2", LEASE, 2_000);
      await store.transition(k2, "signed", {
        state: "rejected",
        errorReason: "x",
        updatedAt: 3_000,
      });
      expect(await store.addHash(k2, "h1", LEASE, 4_000)).toBe(false);
    });

    it("lets exactly one of addHash and a final transition from claimed win, in either order", async () => {
      for (const [nonce, hashFirst] of [
        ["1", true],
        ["2", false],
      ] as const) {
        const { key } = settlement(nonce);
        await store.claim(settlement(nonce));
        // A hash per nonce: another key's `h1` would conflict, not race.
        const add = () => store.addHash(key, `h${nonce}`, LEASE, 2_000);
        const end = () =>
          store.transition(key, "claimed", {
            state: "rejected",
            errorReason: "x",
            updatedAt: 2_000,
          });
        const [added, ended] = hashFirst
          ? await Promise.all([add(), end()])
          : await Promise.all([end(), add()]).then(([e, a]) => [a, e] as const);
        expect(added !== (ended !== undefined)).toBe(true);
        const record = await store.get(key);
        expect(record?.hashes).toEqual(added ? [`h${nonce}`] : []);
        expect(record?.state).toBe(added ? "signed" : "rejected");
      }
    });

    it("lets exactly one caller mark a success as answered, and leaves updatedAt", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.transition(key, "claimed", { state: "success", updatedAt: 3_000 });
      const marks = await Promise.all(
        Array.from({ length: 5 }, () => store.markSuccessAnswered(key, 4_000)),
      );
      expect(marks.filter(Boolean)).toHaveLength(1);
      expect(await store.get(key)).toMatchObject({
        state: "success",
        successAnsweredAt: 4_000,
        updatedAt: 3_000,
      });
      expect(await store.markSuccessAnswered(settlement("9").key, 4_000)).toBe(false);
    });

    it("marks only a success as answered, in no other state", async () => {
      // Each state reached the way `/settle` reaches it.
      const reach: Record<string, (key: SettlementKey) => Promise<unknown>> = {
        claimed: async () => {},
        signed: (key) => store.addHash(key, `h-${key}`, LEASE, 2_000),
        pending: async (key) => {
          await store.addHash(key, `h-${key}`, LEASE, 2_000);
          await store.transition(key, "signed", { state: "pending", updatedAt: 2_000 });
        },
        failed: async (key) => {
          await reach.pending!(key);
          await store.transition(key, "pending", { state: "failed", updatedAt: 3_000 });
        },
        expired: async (key) => {
          await reach.pending!(key);
          await store.transition(key, "pending", { state: "expired", updatedAt: 3_000 });
        },
        rejected: (key) =>
          store.transition(key, "claimed", {
            state: "rejected",
            errorReason: "x",
            updatedAt: 2_000,
          }),
      };
      for (const [index, [state, to]] of Object.entries(reach).entries()) {
        const s = settlement(String(index + 1));
        await store.claim(s);
        await to(s.key);
        expect((await store.get(s.key))?.state).toBe(state);
        expect(await store.markSuccessAnswered(s.key, 4_000)).toBe(false);
        expect(await store.get(s.key)).not.toHaveProperty("successAnsweredAt");
      }
    });

    it("keeps epoch-scale times exact, past 32 bits", async () => {
      // Millisecond times are past 2^31 since 1970-01-26; a 32-bit column would refuse them.
      const at = Date.UTC(2026, 9, 20);
      const s = { ...settlement("1"), createdAt: at };
      await store.claim(s);
      await store.addHash(s.key, "h1", LEASE, at + 1);
      await store.transition(s.key, "signed", { state: "success", updatedAt: at + 2 });
      expect(await store.markSuccessAnswered(s.key, at + 3)).toBe(true);
      expect(await store.get(s.key)).toMatchObject({
        createdAt: at,
        updatedAt: at + 2,
        successAnsweredAt: at + 3,
      });
    });

    it("applies a transition only from the expected state, and only forward", async () => {
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      await store.addHash(key, "h1", LEASE, 2_000);
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

    it("keeps a failure cause with the final record, and has none otherwise", async () => {
      const failure = {
        opCode: "invokeHostFunctionTrapped",
        error: { type: "sceContract", code: "10" },
        contract: "CSAC",
        data: ["GPAYER", "CPAYTO"],
      };
      const { key } = settlement("1");
      await store.claim(settlement("1"));
      expect((await store.get(key))?.failure).toBeUndefined();
      const failed = await store.transition(key, "claimed", {
        state: "failed",
        errorReason: "x",
        failure,
        updatedAt: 2_000,
      });
      expect(failed?.failure).toEqual(failure);
      expect((await store.get(key))?.failure).toEqual(failure);
      await store.claim(settlement("2"));
      const success = await store.transition(settlement("2").key, "claimed", {
        state: "success",
        updatedAt: 2_000,
      });
      expect(success).not.toHaveProperty("failure");
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
      await store.addHash(key, "h1", LEASE, 2_000);
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

    describe("reopen (0073)", () => {
      const UNSENT = ["unsent_a", "unsent_b"];
      const rejected = async (nonce: string, errorReason = "unsent_b", hash?: string) => {
        const s = settlement(nonce);
        await store.claim(s);
        if (hash) await store.addHash(s.key, hash, LEASE, 1_500);
        await store.transition(s.key, hash ? "signed" : "claimed", {
          state: "rejected",
          errorReason,
          updatedAt: 2_000,
        });
        return s;
      };

      it("moves a rejected record nothing was sent for back to claimed, counting the reopen", async () => {
        const s = await rejected("1");
        const reopened = await store.reopen(s.key, s.fingerprint, UNSENT, 5_000);
        // A repeat counts the new claim's budget from createdAt, so it is the reopen's time.
        const record = {
          ...s,
          state: "claimed",
          hashes: [],
          // A writer that read the earlier claim and passes its version fails.
          version: 1,
          reopened: 1,
          createdAt: 5_000,
          updatedAt: 5_000,
        };
        expect(reopened).toEqual(record);
        expect(await store.get(s.key)).toEqual(record);
        await store.transition(s.key, "claimed", {
          state: "rejected",
          errorReason: "unsent_a",
          updatedAt: 6_000,
        });
        expect(await store.reopen(s.key, s.fingerprint, UNSENT, 7_000)).toMatchObject({
          reopened: 2,
        });
      });

      it("clears a transition's errorMessage with its reason (0107)", async () => {
        const s = settlement("1");
        await store.claim(s);
        const rejected = await store.transition(s.key, "claimed", {
          state: "rejected",
          errorReason: "unsent_b",
          errorMessage: "why",
          updatedAt: 2_000,
        });
        expect(rejected).toMatchObject({ errorReason: "unsent_b", errorMessage: "why" });
        expect(await store.get(s.key)).toMatchObject({ errorMessage: "why" });
        // The message is the reason's: a reopened claim has neither.
        expect(await store.reopen(s.key, s.fingerprint, UNSENT, 5_000)).not.toHaveProperty(
          "errorMessage",
        );
        expect(await store.get(s.key)).not.toHaveProperty("errorMessage");
      });

      it("refuses another fingerprint, another reason, a record with a hash, or one not rejected", async () => {
        const s = await rejected("1");
        expect(await store.reopen(s.key, "fp-other", UNSENT, 5_000)).toBeUndefined();
        const refused = await rejected("2", "settle_exact_stellar_refused");
        expect(await store.reopen(refused.key, refused.fingerprint, UNSENT, 5_000)).toBeUndefined();
        const sent = await rejected("3", "unsent_a", "h3");
        expect(await store.reopen(sent.key, sent.fingerprint, UNSENT, 5_000)).toBeUndefined();
        const open = settlement("4");
        await store.claim(open);
        expect(await store.reopen(open.key, open.fingerprint, UNSENT, 5_000)).toBeUndefined();
        expect(await store.reopen(settlement("5").key, "fp-5", UNSENT, 5_000)).toBeUndefined();
        for (const [record, state] of [
          [s, "rejected"],
          [refused, "rejected"],
          [sent, "rejected"],
          [open, "claimed"],
        ] as const)
          expect(await store.get(record.key)).toMatchObject({ state, reopened: 0 });
      });

      it("fails a writer that read the earlier claim: a versioned close, or a hash for that claim", async () => {
        const s = await rejected("1");
        const before = (await store.get(s.key))!;
        await store.reopen(s.key, s.fingerprint, UNSENT, 5_000);
        const close = { state: "rejected", errorReason: "unsent_a", updatedAt: 6_000 } as const;
        expect(await store.transition(s.key, "claimed", close, before.version)).toBeUndefined();
        expect(await store.addHash(s.key, "h1", LEASE, 6_000, undefined, before.reopened)).toBe(
          false,
        );
        // Any write of the earlier claim's call, versioned or not (0073 decision 24).
        expect(
          await store.transition(s.key, "claimed", close, undefined, before.reopened),
        ).toBeUndefined();
        // A late refusal carries attempts, which the store writes in a transaction of their own.
        const refusal = {
          ...close,
          attempts: [{ hash: "h0", state: "dead" as const, errorCode: "txBadSeq" }],
        };
        expect(
          await store.transition(s.key, "claimed", refusal, undefined, before.reopened),
        ).toBeUndefined();
        expect(await store.get(s.key)).toMatchObject({ state: "claimed", hashes: [] });
        expect(await store.addHash(s.key, "h1", LEASE, 6_000, undefined, 1)).toBe(true);
        expect(await store.get(s.key)).toMatchObject({ state: "signed", hashes: ["h1"] });
        const pending = { state: "pending", updatedAt: 7_000 } as const;
        expect(await store.transition(s.key, "signed", pending, undefined, 1)).toMatchObject({
          state: "pending",
        });
      });

      it("lets exactly one of several concurrent reopens win", async () => {
        const s = await rejected("1");
        const results = await Promise.all(
          Array.from({ length: 10 }, () => store.reopen(s.key, s.fingerprint, UNSENT, 5_000)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await store.get(s.key))?.reopened).toBe(1);
      });
    });

    describe("refuse (0086)", () => {
      const UNSENT = ["unsent_a"];
      const FEE = { errorReason: "invalid_fee", errorMessage: "too high", errorDetail: "our_code" };

      it("inserts a refused record with the checks' reason and message, no hash, never reopening", async () => {
        const s = settlement("1");
        const record = {
          ...s,
          state: "refused",
          hashes: [],
          version: 0,
          reopened: 0,
          errorReason: "invalid_fee",
          errorMessage: "too high",
          errorDetail: "our_code",
          createdAt: 1_000,
          updatedAt: 2_000,
        };
        expect(await store.refuse(s, FEE, UNSENT, 2_000)).toEqual(record);
        expect(await store.get(s.key)).toEqual(record);
        // Final: no transition, no reopen, no hash, and a claim finds it.
        expect(
          await store.transition(s.key, "refused", { state: "success", updatedAt: 3_000 }),
        ).toBeUndefined();
        expect(await store.reopen(s.key, s.fingerprint, ["invalid_fee"], 3_000)).toBeUndefined();
        expect(await store.addHash(s.key, "h1", LEASE, 3_000)).toBe(false);
        expect(await store.claim(s)).toEqual({ claimed: false, existing: record });
        expect(await store.listNonFinal("stellar:testnet")).toEqual([]);
      });

      it("keeps the message empty when the checks gave none", async () => {
        const s = settlement("1");
        const record = await store.refuse(s, { errorReason: "invalid_x" }, UNSENT, 2_000);
        expect(record).not.toHaveProperty("errorMessage");
        expect(record).not.toHaveProperty("errorDetail");
      });

      it("takes no payer and asset slot, and never waits for one", async () => {
        const open = settlement("1");
        await store.claim(open);
        // Another key of the same payer and asset is settling: a claim would be busy.
        expect(await store.refuse(settlement("2"), FEE, UNSENT, 2_000)).toMatchObject({
          state: "refused",
        });
        await store.transition(open.key, "claimed", { state: "success", updatedAt: 3_000 });
        expect(await store.claim(settlement("3"))).toMatchObject({ claimed: true });
      });

      it("moves a reopenable rejected record of the same payment to refused, once", async () => {
        const s = settlement("1");
        await store.claim(s);
        await store.transition(s.key, "claimed", {
          state: "rejected",
          errorReason: "unsent_a",
          updatedAt: 2_000,
        });
        expect(await store.refuse(s, FEE, UNSENT, 3_000)).toMatchObject({
          state: "refused",
          errorReason: "invalid_fee",
          errorMessage: "too high",
          version: 1,
          reopened: 0,
          createdAt: 1_000,
          updatedAt: 3_000,
        });
        expect(await store.reopen(s.key, s.fingerprint, UNSENT, 4_000)).toBeUndefined();
      });

      it("leaves any other record as it is: open, sent, another reason or another payload", async () => {
        const open = settlement("1");
        await store.claim(open);
        const sent = settlement("2");
        await store.claim(sent);
        await store.addHash(sent.key, "h2", LEASE, 1_500);
        await store.transition(sent.key, "signed", {
          state: "rejected",
          errorReason: "unsent_a",
          updatedAt: 2_000,
        });
        const other = settlement("3");
        await store.claim(other);
        await store.transition(other.key, "claimed", {
          state: "rejected",
          errorReason: "settle_exact_stellar_refused",
          updatedAt: 2_000,
        });
        const unsent = settlement("4");
        await store.claim(unsent);
        await store.transition(unsent.key, "claimed", {
          state: "rejected",
          errorReason: "unsent_a",
          updatedAt: 2_000,
        });
        for (const [s, state] of [
          [open, "claimed"],
          [sent, "rejected"],
          [other, "rejected"],
        ] as const) {
          const before = await store.get(s.key);
          expect(await store.refuse(s, FEE, UNSENT, 3_000)).toEqual(before);
          expect(before?.state).toBe(state);
        }
        const before = await store.get(unsent.key);
        expect(
          await store.refuse({ ...unsent, fingerprint: "fp-other" }, FEE, UNSENT, 3_000),
        ).toEqual(before);
      });

      it("lets exactly one of a refuse and a reopen of the same record win", async () => {
        for (const nonce of ["1", "2", "3", "4", "5"]) {
          const s = settlement(nonce);
          await store.claim(s);
          await store.transition(s.key, "claimed", {
            state: "rejected",
            errorReason: "unsent_a",
            updatedAt: 2_000,
          });
          const [refused, reopened] = await Promise.all([
            store.refuse(s, FEE, UNSENT, 3_000),
            store.reopen(s.key, s.fingerprint, UNSENT, 3_000),
          ]);
          const record = await store.get(s.key);
          if (record?.state === "refused") {
            expect(reopened).toBeUndefined();
          } else {
            expect(record?.state).toBe("claimed");
            expect(reopened).toMatchObject({ state: "claimed" });
            expect(refused).toMatchObject({ state: "claimed" });
          }
          // Free the slot for the next payment of the same payer and asset.
          if (record?.state === "claimed")
            await store.transition(s.key, "claimed", {
              state: "rejected",
              errorReason: "x",
              updatedAt: 4_000,
            });
        }
      });

      it("is never a transition's target: only refuse writes it", async () => {
        const s = settlement("1");
        await store.claim(s);
        expect(
          await store.transition(s.key, "claimed", {
            state: "refused",
            errorReason: "invalid_fee",
            updatedAt: 2_000,
          }),
        ).toBeUndefined();
        expect(await store.get(s.key)).toMatchObject({ state: "claimed" });
      });

      it("prunes only refused records created before the cutoff, in batches", async () => {
        for (const nonce of ["1", "2", "3"])
          await store.refuse({ ...settlement(nonce), createdAt: 1_000 }, FEE, UNSENT, 1_000);
        await store.refuse({ ...settlement("4"), createdAt: 9_000 }, FEE, UNSENT, 9_000);
        const kept = settlement("5");
        await store.claim(kept);
        await store.transition(kept.key, "claimed", {
          state: "rejected",
          errorReason: "invalid_like",
          updatedAt: 2_000,
        });
        expect(await store.pruneRefusals(5_000, undefined, 2)).toBe(2);
        expect(await store.pruneRefusals(5_000, undefined, 2)).toBe(1);
        expect(await store.pruneRefusals(5_000, undefined, 2)).toBe(0);
        expect(await store.get(settlement("4").key)).toMatchObject({ state: "refused" });
        expect(await store.get(kept.key)).toMatchObject({ state: "rejected" });
      });

      it("keeps a refused record until its expiration ledger has closed on its network", async () => {
        const at = (nonce: string, expirationLedger: number) =>
          store.refuse(
            { ...settlement(nonce), createdAt: 1_000 },
            { ...FEE, expirationLedger },
            UNSENT,
            1_000,
          );
        await at("1", 99);
        await at("2", 100);
        await at("3", 101);
        const testnet = { network: "stellar:testnet" as const, latest: 100 };
        // No ledger read: only records without an expiration go.
        expect(await store.pruneRefusals(5_000, undefined, 10)).toBe(0);
        // Another network's ledger counts for nothing here.
        expect(
          await store.pruneRefusals(5_000, { ...testnet, network: "stellar:pubnet" }, 10),
        ).toBe(0);
        // Not before the hour either.
        expect(await store.pruneRefusals(1_000, testnet, 10)).toBe(0);
        expect(await store.pruneRefusals(5_000, testnet, 10)).toBe(2);
        expect(await store.get(settlement("3").key)).toMatchObject({ state: "refused" });
        expect(await store.pruneRefusals(5_000, { ...testnet, latest: 101 }, 10)).toBe(1);
      });

      it("keeps the expiration ledger when it moves a rejected record to refused", async () => {
        const s = settlement("1");
        await store.claim(s);
        await store.transition(s.key, "claimed", {
          state: "rejected",
          errorReason: "unsent_a",
          updatedAt: 2_000,
        });
        await store.refuse(s, { ...FEE, expirationLedger: 200 }, UNSENT, 3_000);
        const testnet = { network: "stellar:testnet" as const, latest: 199 };
        expect(await store.pruneRefusals(5_000, testnet, 10)).toBe(0);
        expect(await store.pruneRefusals(5_000, { ...testnet, latest: 200 }, 10)).toBe(1);
      });
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
      await store.addHash(k1, "h1", LEASE, 2_000);
      await store.transition(k1, "signed", { state: "pending", updatedAt: 3_000 });
      // A rebuilt transaction (a fee bump) adds a hash while the record is pending.
      expect(await store.addHash(k1, "h2", LEASE, 4_000)).toBe(true);
      expect(await store.get(k1)).toMatchObject({ state: "pending", hashes: ["h1", "h2"] });
      await store.addHash(k2, "h3", LEASE, 2_000);
      const open = (await store.listNonFinal("stellar:testnet")).sort((a, b) =>
        a.nonce.localeCompare(b.nonce),
      );
      expect(open.map((r) => [r.nonce, r.state, r.hashes])).toEqual([
        ["1", "pending", ["h1", "h2"]],
        ["2", "signed", ["h3"]],
      ]);
    });

    describe("attempts (0019 decision 7)", () => {
      const { key } = settlement("1");
      beforeEach(async () => {
        await store.claim(settlement("1"));
      });

      it("stores each hash as a stored attempt with its bounds, oldest first", async () => {
        await store.addHash(key, "h1", LEASE, 2_000, {
          maxTime: 1_700_000_060,
          maxLedger: 5_000_123,
        });
        await store.addHash(key, "h2", LEASE, 3_000, { maxTime: 1_700_000_090 });
        await store.addHash(key, "h3", LEASE, 4_000);
        // A repeat changes nothing, its bounds included.
        await store.addHash(key, "h1", LEASE, 5_000, { maxTime: 1 });
        expect(await store.attempts(key)).toEqual([
          {
            hash: "h1",
            state: "stored",
            maxTime: 1_700_000_060,
            maxLedger: 5_000_123,
            updatedAt: 2_000,
          },
          { hash: "h2", state: "stored", maxTime: 1_700_000_090, updatedAt: 3_000 },
          { hash: "h3", state: "stored", updatedAt: 4_000 },
        ]);
        expect(await store.attempts(settlement("2").key)).toEqual([]);
      });

      it("moves attempts only forward, each on its own", async () => {
        await store.addHash(key, "h1", LEASE, 2_000);
        await store.addHash(key, "h2", LEASE, 2_000);
        expect(await store.markAttempts(key, [{ hash: "h1", state: "sent" }], 3_000)).toBe(1);
        // sent and unknown rank alike, so neither replaces the other; nothing moves back.
        expect(
          await store.markAttempts(
            key,
            [
              { hash: "h1", state: "unknown" },
              { hash: "h1", state: "stored" },
            ],
            4_000,
          ),
        ).toBe(0);
        expect(
          await store.markAttempts(
            key,
            [
              { hash: "h1", state: "dead", channel: "GCHANNEL", errorCode: "txBadSeq" },
              { hash: "h2", state: "landed", channel: "GCHANNEL" },
            ],
            5_000,
          ),
        ).toBe(2);
        // landed and dead are final.
        expect(
          await store.markAttempts(
            key,
            [
              { hash: "h1", state: "landed" },
              { hash: "h2", state: "dead" },
            ],
            6_000,
          ),
        ).toBe(0);
        expect(await store.attempts(key)).toEqual([
          {
            hash: "h1",
            state: "dead",
            channel: "GCHANNEL",
            errorCode: "txBadSeq",
            updatedAt: 5_000,
          },
          { hash: "h2", state: "landed", channel: "GCHANNEL", updatedAt: 5_000 },
        ]);
      });

      it("keeps each hash's inner hash, none for one stored without (0087)", async () => {
        await store.addHash(key, "h1", LEASE, 2_000, { maxLedger: 9 }, undefined, "i1");
        await store.addHash(key, "h2", LEASE, 3_000);
        expect((await store.attempts(key)).map((a) => a.innerHash)).toEqual(["i1", undefined]);
      });

      it("adds the hash that landed in place of an attempt, last, with its inner hash (0087)", async () => {
        await store.addHash(key, "h1", LEASE, 2_000, undefined, undefined, "i1");
        expect(
          await store.markAttempts(
            key,
            [
              { hash: "h1", state: "dead" },
              { hash: "r1", state: "landed", rewrapOf: "h1", channel: "GCHANNEL" },
            ],
            3_000,
          ),
        ).toBe(2);
        expect(await store.attempts(key)).toEqual([
          { hash: "h1", state: "dead", innerHash: "i1", updatedAt: 3_000 },
          { hash: "r1", state: "landed", channel: "GCHANNEL", innerHash: "i1", updatedAt: 3_000 },
        ]);
        // The record's last hash is the one that landed, and it finds the record.
        expect((await store.get(key))?.hashes).toEqual(["h1", "r1"]);
        expect((await store.findByHash("r1"))?.key).toBe(key);
        // Repeated, it adds nothing.
        expect(
          await store.markAttempts(key, [{ hash: "r1", state: "landed", rewrapOf: "h1" }], 4_000),
        ).toBe(0);
      });

      it("adds no landed hash in place of an attempt the record doesn't have (0087)", async () => {
        const k2 = settlement("2").key;
        await store.claim(settlement("2"));
        await store.addHash(k2, "h9", LEASE, 2_000, undefined, undefined, "i9");
        expect(
          await store.markAttempts(key, [{ hash: "r9", state: "landed", rewrapOf: "h9" }], 3_000),
        ).toBe(0);
        expect(await store.findByHash("r9")).toBeUndefined();
      });

      it("adds a rewrap's landed hash with a transition to success (0087)", async () => {
        await store.addHash(key, "h1", LEASE, 2_000, undefined, undefined, "i1");
        const moved = await store.transition(key, "signed", {
          state: "success",
          ledger: 7,
          feeCharged: 0n,
          updatedAt: 3_000,
          attempts: [
            { hash: "h1", state: "dead" },
            { hash: "r1", state: "landed", rewrapOf: "h1" },
          ],
        });
        expect(moved).toMatchObject({ state: "success", hashes: ["h1", "r1"], feeCharged: 0n });
      });

      it("never moves another record's attempt", async () => {
        const k2 = settlement("2").key;
        await store.claim(settlement("2"));
        await store.addHash(k2, "h9", LEASE, 2_000);
        expect(await store.markAttempts(key, [{ hash: "h9", state: "dead" }], 3_000)).toBe(0);
        expect((await store.attempts(k2))[0]?.state).toBe("stored");
      });

      it("lets exactly one of concurrent updates of an attempt win", async () => {
        await store.addHash(key, "h1", LEASE, 2_000);
        const moved = await Promise.all(
          (["sent", "unknown", "sent", "unknown"] as const).map((state) =>
            store.markAttempts(key, [{ hash: "h1", state }], 3_000),
          ),
        );
        expect(moved.reduce((a, b) => a + b)).toBe(1);
      });

      it("writes a transition's attempts with it, also when the state doesn't move", async () => {
        await store.addHash(key, "h1", LEASE, 2_000);
        await store.addHash(key, "h2", LEASE, 2_000);
        const moved = await store.transition(key, "signed", {
          state: "success",
          ledger: 7,
          updatedAt: 3_000,
          attempts: [
            { hash: "h1", state: "dead", errorCode: "txBadSeq" },
            { hash: "h2", state: "landed" },
          ],
        });
        // The record carries no attempts: they are read with `attempts`.
        expect(moved).toMatchObject({ state: "success", hashes: ["h1", "h2"] });
        expect(moved).not.toHaveProperty("attempts");
        expect((await store.attempts(key)).map((a) => a.state)).toEqual(["dead", "landed"]);

        const k2 = settlement("2").key;
        await store.claim(settlement("2"));
        await store.addHash(k2, "h3", LEASE, 2_000);
        // A lost compare-and-set still records what the network said about the attempt.
        expect(
          await store.transition(k2, "pending", {
            state: "expired",
            updatedAt: 3_000,
            attempts: [{ hash: "h3", state: "dead" }],
          }),
        ).toBeUndefined();
        expect(await store.get(k2)).toMatchObject({ state: "signed" });
        expect((await store.attempts(k2))[0]?.state).toBe("dead");
      });
    });

    describe("one non-final settlement per payer and asset (0024)", () => {
      /** A settlement in one asset, `CONE`, unless the overrides say otherwise. */
      const of = (
        nonce: string,
        overrides: { payer?: string; asset?: string; network?: StellarNetwork } = {},
      ): NewSettlement => {
        const network = overrides.network ?? "stellar:testnet";
        const payer = overrides.payer ?? PAYER;
        return {
          ...settlement(nonce, network, overrides.asset ?? "CONE"),
          key: `${network}:${payer}:${nonce}` as SettlementKey,
          payer,
        };
      };
      const reject = (key: SettlementKey) =>
        store.transition(key, "claimed", { state: "rejected", errorReason: "x", updatedAt: 2_000 });

      it("answers busy with the blocker's key for a second key of one payer and asset", async () => {
        expect(await store.claim(of("1"))).toMatchObject({ claimed: true });
        expect(await store.claim(of("2"))).toEqual({ claimed: false, busy: of("1").key });
        // No record is written, so the same payment can be claimed later.
        expect(await store.get(of("2").key)).toBeUndefined();
        expect((await store.listNonFinal("stellar:testnet")).map((r) => r.nonce)).toEqual(["1"]);
      });

      it("gives one of several concurrent keys of one payer and asset the claim, the rest its key", async () => {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => store.claim(of(String(i)))),
        );
        const winners = results.flatMap((result) => (result.claimed ? [result.record.key] : []));
        expect(winners).toHaveLength(1);
        const winner = winners[0];
        expect(results.filter((result) => !result.claimed)).toEqual(
          Array.from({ length: 9 }, () => ({ claimed: false, busy: winner })),
        );
        expect((await store.listNonFinal("stellar:testnet")).map((r) => r.key)).toEqual([winner]);
      });

      it("claims for another asset, another payer or another network", async () => {
        await store.claim(of("1"));
        for (const other of [
          of("2", { asset: "CTWO" }),
          of("3", { payer: "GOTHER" }),
          of("4", { network: "stellar:pubnet" }),
        ])
          expect(await store.claim(other)).toMatchObject({ claimed: true });
      });

      it("still answers existing for a repeat of the same key", async () => {
        await store.claim(of("1"));
        expect(await store.claim(of("1"))).toMatchObject({
          claimed: false,
          existing: { key: of("1").key, state: "claimed" },
        });
        // Also once it is final and another key of the payer and asset holds the slot.
        await reject(of("1").key);
        await store.claim(of("2"));
        expect(await store.claim(of("1"))).toMatchObject({
          claimed: false,
          existing: { key: of("1").key, state: "rejected" },
        });
      });

      it("frees the slot when the blocker turns final, in any final state, and not before", async () => {
        const ends: ((key: SettlementKey) => Promise<unknown>)[] = [
          reject,
          (key) => store.transition(key, "claimed", { state: "expired", updatedAt: 2_000 }),
          (key) => store.transition(key, "claimed", { state: "failed", updatedAt: 2_000 }),
          // Through the transaction that writes attempts too.
          async (key) => {
            await store.addHash(key, `h-${key}`, LEASE, 2_000);
            await store.transition(key, "signed", { state: "pending", updatedAt: 2_500 });
            expect(await store.claim(of("next"))).toEqual({ claimed: false, busy: key });
            return store.transition(key, "pending", {
              state: "success",
              updatedAt: 3_000,
              attempts: [{ hash: `h-${key}`, state: "landed" }],
            });
          },
        ];
        for (const [i, end] of ends.entries()) {
          const { key } = of(String(i));
          expect(await store.claim(of(String(i)))).toMatchObject({ claimed: true });
          // A compare-and-set that lost moves nothing, so it frees nothing.
          await store.transition(key, "signed", { state: "expired", updatedAt: 2_000 });
          expect(await store.claim(of("next"))).toEqual({ claimed: false, busy: key });
          await end(key);
          expect(await store.claim(of(`after-${i}`))).toMatchObject({ claimed: true });
          await reject(of(`after-${i}`).key);
        }
      });

      it("never leaves the slot held when a claim races the blocker's final transition", async () => {
        for (let i = 0; i < 10; i++) {
          const [a, b] = [of(`a${i}`), of(`b${i}`)];
          await store.claim(a);
          const [, raced] = await Promise.all([reject(a.key), store.claim(b)]);
          if (!raced.claimed) {
            expect(raced).toEqual({ claimed: false, busy: a.key });
            expect(await store.claim(b)).toMatchObject({ claimed: true });
          }
          await reject(b.key);
        }
      });

      describe("reopen (0073)", () => {
        const REASONS = ["x"];

        it("answers busy, and leaves the record closed, while another key holds the slot", async () => {
          const closed = of("1");
          await store.claim(closed);
          await reject(closed.key);
          await store.claim(of("2"));
          const before = await store.get(closed.key);

          expect(await store.reopen(closed.key, closed.fingerprint, REASONS, 5_000)).toEqual({
            busy: of("2").key,
          });
          expect(await store.get(closed.key)).toEqual(before);

          await reject(of("2").key);
          expect(await store.reopen(closed.key, closed.fingerprint, REASONS, 6_000)).toMatchObject({
            state: "claimed",
            reopened: 1,
          });
        });

        it("takes the slot, so a reopened record blocks other keys until it is final", async () => {
          const closed = of("1");
          await store.claim(closed);
          await reject(closed.key);

          await store.reopen(closed.key, closed.fingerprint, REASONS, 5_000);
          expect(await store.claim(of("2"))).toEqual({ claimed: false, busy: closed.key });

          await store.transition(closed.key, "claimed", {
            state: "rejected",
            errorReason: "x",
            updatedAt: 6_000,
          });
          expect(await store.claim(of("2"))).toMatchObject({ claimed: true });
        });

        it("lets one of a reopen and a claim of one payer and asset hold the slot", async () => {
          for (let i = 0; i < 10; i++) {
            const [closed, other] = [of(`c${i}`), of(`o${i}`)];
            await store.claim(closed);
            await reject(closed.key);
            const [reopened, claimed] = await Promise.all([
              store.reopen(closed.key, closed.fingerprint, REASONS, 5_000),
              store.claim(other),
            ]);
            expect(reopened).toBeDefined();
            const holders = [
              reopened !== undefined && !("busy" in reopened),
              claimed.claimed,
            ].filter(Boolean);
            expect(holders).toHaveLength(1);
            await reject(claimed.claimed ? other.key : closed.key);
          }
        });
      });
    });

    describe("channel lease", () => {
      const NAME = "stellar:testnet:channels";

      it("gives the lease to one holder until the skew margin past its expiry", async () => {
        expect(await store.acquireLease(NAME, "a", 1_000, 0)).toEqual({
          name: NAME,
          holder: "a",
          expiresAt: 1_000,
          token: expect.any(String),
        });
        expect(await store.acquireLease(NAME, "b", 1_000, 500)).toBeUndefined();
        // Expired, but the holder's clock may lag the acquirer's (0025 decision 16).
        const free = 1_000 + LEASE_SKEW_MARGIN_MS;
        expect(await store.acquireLease(NAME, "b", 1_000, free)).toBeUndefined();
        expect(await store.acquireLease(NAME, "b", 1_000, free + 1)).toMatchObject({ holder: "b" });
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
          Array.from({ length: 10 }, (_, i) =>
            store.acquireLease(NAME, `h${i}`, 1_000, 1_001 + LEASE_SKEW_MARGIN_MS),
          ),
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

      it("draws a new token on every acquire, its own holder's too, and keeps it on a renewal (0071)", async () => {
        const first = await store.acquireLease(NAME, "a", 1_000, 0);
        expect(await store.renewLease(NAME, "a", 1_000, 500)).toBe(true);
        // The keeper takes it again only after it lapsed, but any acquire draws a new token.
        const again = await store.acquireLease(NAME, "a", 1_000, 2_000);
        const taken = await store.acquireLease(NAME, "b", 1_000, 3_001 + LEASE_SKEW_MARGIN_MS);
        await store.releaseLease(NAME, "b");
        // A release deletes the row, and a new one never repeats an earlier token.
        const fresh = await store.acquireLease(NAME, "a", 1_000, 10_000);
        const tokens = [first, again, taken, fresh].map((lease) => lease?.token);
        expect(new Set(tokens).size).toBe(4);
        expect(tokens.every((token) => typeof token === "string")).toBe(true);
      });
    });

    describe("lease fencing (0071)", () => {
      const NAME = "stellar:testnet:channels";

      it("stores a hash under the lease's current token", async () => {
        const lease = (await store.acquireLease(NAME, "a", 1_000, 0))!;
        const s = settlement("1");
        await store.claim(s);
        expect(await store.addHash(s.key, "h1", lease, 2_000)).toBe(true);
        expect(await store.get(s.key)).toMatchObject({ state: "signed", hashes: ["h1"] });
      });

      it("refuses a hash under a token another acquire replaced, and changes nothing", async () => {
        const stale = (await store.acquireLease(NAME, "a", 1_000, 0))!;
        await store.acquireLease(NAME, "b", 1_000, 1_001 + LEASE_SKEW_MARGIN_MS);
        const s = settlement("1");
        await store.claim(s);
        await expect(store.addHash(s.key, "h1", stale, 2_000)).rejects.toBeInstanceOf(
          LeaseFencedError,
        );
        expect(await store.get(s.key)).toMatchObject({ state: "claimed", hashes: [], version: 0 });
        expect(await store.findByHash("h1")).toBeUndefined();
      });

      it("refuses a hash under its own holder's earlier token, once it acquired again", async () => {
        const before = (await store.acquireLease(NAME, "a", 1_000, 0))!;
        const after = (await store.acquireLease(NAME, "a", 1_000, 2_000))!;
        const s = settlement("1");
        await store.claim(s);
        await expect(store.addHash(s.key, "h1", before, 2_500)).rejects.toBeInstanceOf(
          LeaseFencedError,
        );
        expect(await store.addHash(s.key, "h1", after, 2_500)).toBe(true);
      });

      it("refuses a hash once the lease was released, or under another lease's name", async () => {
        const lease = (await store.acquireLease(NAME, "a", 1_000, 0))!;
        const s = settlement("1");
        await store.claim(s);
        const other = { name: "stellar:pubnet:channels", token: lease.token };
        await expect(store.addHash(s.key, "h1", other, 2_000)).rejects.toBeInstanceOf(
          LeaseFencedError,
        );
        await store.releaseLease(NAME, "a");
        await expect(store.addHash(s.key, "h1", lease, 2_000)).rejects.toBeInstanceOf(
          LeaseFencedError,
        );
        expect(await store.get(s.key)).toMatchObject({ state: "claimed", hashes: [] });
      });

      it("refuses a stale token before anything else, a hash already on the record too", async () => {
        const stale = (await store.acquireLease(NAME, "a", 1_000, 0))!;
        const s = settlement("1");
        await store.claim(s);
        // The fence comes first, so a hash already on the record gets no "already stored" answer.
        await store.addHash(s.key, "h1", stale, 2_000);
        await store.acquireLease(NAME, "b", 1_000, 1_001 + LEASE_SKEW_MARGIN_MS);
        await expect(store.addHash(s.key, "h1", stale, 3_000)).rejects.toBeInstanceOf(
          LeaseFencedError,
        );
      });

      it("still finishes a record a stale holder sent for: transition isn't fenced", async () => {
        const stale = (await store.acquireLease(NAME, "a", 1_000, 0))!;
        const s = settlement("1");
        await store.claim(s);
        await store.addHash(s.key, "h1", stale, 2_000);
        await store.acquireLease(NAME, "b", 1_000, 1_001 + LEASE_SKEW_MARGIN_MS);
        expect(
          await store.transition(s.key, "signed", { state: "success", updatedAt: 9_000 }),
        ).toMatchObject({ state: "success", hashes: ["h1"] });
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
      expect(
        await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 }),
      ).toMatchObject({ reserved: true });
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 1 })).toEqual({
        reserved: false,
        scope: "global",
        limit: "stroops",
      });
      expect(await store.used(`payer:${PAYER}`, DAY, 1)).toBe(60n);
      expect(
        await store.reserve({ id: "c", amount: 30n, limits: limits(1_000n, 80n), now: 2 }),
      ).toEqual({ reserved: false, scope: `payer:${PAYER}`, limit: "stroops" });
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
      ).toMatchObject({ reserved: true });
      expect(await store.used("global", DAY, 0)).toBe(INT64_MAX);
      expect(await store.used(`payer:${PAYER}`, DAY, 0)).toBe(INT64_MAX);
      expect(
        await store.reserve({ id: "b", amount: 1n, limits: limits(INT64_MAX, INT64_MAX), now: 0 }),
      ).toEqual({ reserved: false, scope: "global", limit: "stroops" });
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
      await expect(store.commit("a", -1n)).rejects.toBeInstanceOf(RangeError);
      expect(await store.used("global", DAY, 10)).toBe(60n);
    });

    it("treats a repeated id as a no-op", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(
        await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 1 }),
      ).toMatchObject({ reserved: true });
      expect(await store.used("global", DAY, 1)).toBe(60n);
    });

    it("reserves a previously rejected id once budget frees up", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 1 })).toEqual({
        reserved: false,
        scope: "global",
        limit: "stroops",
      });
      await store.release("a", 5);
      expect(
        await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 2 }),
      ).toMatchObject({ reserved: true });
      expect(await store.used("global", DAY, 2)).toBe(60n);
    });

    it("counts a reservation stamped after now", async () => {
      // A caller takes `now` before waiting on the scope lock, so a later stamp can win it first.
      await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: 1_001 });
      expect(
        await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 1_000 }),
      ).toEqual({ reserved: false, scope: "global", limit: "stroops" });
      expect(await store.used("global", DAY, 1_000)).toBe(60n);
    });

    it("commits the fee actually paid and releases what was never spent", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await store.reserve({ id: "b", amount: 30n, limits: limits(100n), now: 0 });
      await store.commit("a", 20n);
      await store.release("b", 5);
      expect(await store.used("global", DAY, 10)).toBe(20n);
    });

    it("keeps a committed fee at its reservation's time, however late the commit", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      // Reconciliation can end a settlement hours after its transaction landed (0019); the fee
      // was paid then, so it leaves the window with the reservation.
      await store.commit("a", 20n);
      expect(await store.used("global", DAY, DAY - 1)).toBe(20n);
      expect(await store.used("global", DAY, DAY)).toBe(0n);
    });

    it("keeps a committed fee through a release, and reports a commit of an unknown id", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.commit("a", 20n)).toBe(true);
      // The fee was paid on-chain; a late release (a timed-out path) can't hand it back.
      await store.release("a", 5);
      expect(await store.used("global", DAY, 10)).toBe(20n);
      expect(await store.commit("missing", 20n)).toBe(false);
      expect(await store.used("global", DAY, 10)).toBe(20n);
    });

    it("returns each limit's window sum, this reservation included", async () => {
      await store.reserve({ id: "a", amount: 10n, limits: limits(100n), now: 0 });
      const result = await store.reserve({
        id: "b",
        amount: 30n,
        limits: limits(100n, 500n),
        now: 1,
      });
      expect(result).toEqual({
        reserved: true,
        usage: [
          { scope: "global", usedStroops: 40n, maxStroops: 100n, windowMs: DAY },
          { scope: `payer:${PAYER}`, usedStroops: 40n, maxStroops: 500n, windowMs: DAY },
        ],
      });
    });

    it("returns no usage for a repeated id", async () => {
      await store.reserve({ id: "a", amount: 10n, limits: limits(100n), now: 0 });
      expect(await store.reserve({ id: "a", amount: 10n, limits: limits(100n), now: 1 })).toEqual({
        reserved: true,
        usage: [],
      });
      await store.commit("a", 5n);
      expect(await store.reserve({ id: "a", amount: 10n, limits: limits(100n), now: 2 })).toEqual({
        reserved: true,
        usage: [],
      });
    });

    it("refuses a reserve after its release and counts nothing", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await store.release("a", 1);
      expect(await store.used("global", DAY, 1)).toBe(0n);
      expect(await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 2 })).toEqual({
        reserved: false,
        released: true,
      });
      expect(await store.used("global", DAY, 2)).toBe(0n);
      await store.release("a", 3);
      expect(await store.used("global", DAY, 3)).toBe(0n);
    });

    it("tombstones a release of an unknown id, so a later reserve is refused", async () => {
      await store.release("a", 1);
      expect(await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 2 })).toEqual({
        reserved: false,
        released: true,
      });
      expect(await store.used("global", DAY, 2)).toBe(0n);
    });

    it("keeps a committed reservation on release", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await store.commit("a", 20n);
      await store.release("a", 5);
      expect(await store.used("global", DAY, 5)).toBe(20n);
      expect(await store.used(`payer:${PAYER}`, DAY, 5)).toBe(20n);
    });

    it("resolves commit false on a released id", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      await store.release("a", 1);
      expect(await store.commit("a", 20n)).toBe(false);
      await store.release("b", 1);
      expect(await store.commit("b", 20n)).toBe(false);
      expect(await store.used("global", DAY, 2)).toBe(0n);
    });

    it("prunes released rows like the others", async () => {
      await store.release("a", 1);
      expect(await store.prune(2, 10)).toBe(1);
      expect(
        await store.reserve({ id: "a", amount: 10n, limits: limits(100n), now: 3 }),
      ).toMatchObject({
        reserved: true,
      });
    });

    it("never leaves a reservation counted when a release races its reserve", async () => {
      for (let i = 0; i < 20; i++) {
        const id = `r${i}`;
        await Promise.all([
          store.reserve({ id, amount: 10n, limits: limits(1_000n), now: 0 }),
          store.release(id, 0),
        ]);
      }
      expect(await store.used("global", DAY, 0)).toBe(0n);
    });

    it("counts only the rolling window", async () => {
      await store.reserve({ id: "a", amount: 60n, limits: limits(100n), now: 0 });
      expect(await store.used("global", DAY, DAY - 1)).toBe(60n);
      expect(await store.used("global", DAY, DAY)).toBe(0n);
      expect(
        await store.reserve({ id: "b", amount: 60n, limits: limits(100n), now: DAY }),
      ).toMatchObject({ reserved: true });
    });

    it("prunes reservations stamped before a time, in either state, at most a limit at a time", async () => {
      await store.reserve({ id: "a", amount: 10n, limits: limits(1_000n), now: 1 });
      await store.reserve({ id: "b", amount: 20n, limits: limits(1_000n), now: 2 });
      await store.reserve({ id: "c", amount: 40n, limits: limits(1_000n), now: 3 });
      await store.commit("a", 5n);
      // `b` stays reserved: a crash between reserve and commit.
      expect(await store.prune(3, 1)).toBe(1);
      expect(await store.prune(3, 10)).toBe(1);
      expect(await store.prune(3, 10)).toBe(0);
      // `c`, stamped at the cutoff, is kept.
      expect(await store.used("global", DAY, 3)).toBe(40n);
      expect(await store.used(`payer:${PAYER}`, DAY, 3)).toBe(40n);
      expect(await store.commit("a", 5n)).toBe(false);
      expect(await store.commit("b", 5n)).toBe(false);
    });

    it("counts each scope on its own, and only the scopes a reservation lists", async () => {
      const payer = (name: string): SpendLimit[] => [
        { scope: `payer:${name}`, maxStroops: 100n, windowMs: DAY },
      ];
      await store.reserve({ id: "a", amount: 80n, limits: payer("A"), now: 0 });
      expect(
        await store.reserve({ id: "b", amount: 80n, limits: payer("B"), now: 0 }),
      ).toMatchObject({ reserved: true });
      expect(await store.used("payer:A", DAY, 0)).toBe(80n);
      expect(await store.used("payer:B", DAY, 0)).toBe(80n);
      expect(await store.used("global", DAY, 0)).toBe(0n);
    });

    it("sums and reports each stroop limit over its own window", async () => {
      const HOUR = 3_600_000;
      await store.reserve({ id: "a", amount: 10n, limits: limits(1_000n), now: 0 });
      const result = await store.reserve({
        id: "b",
        amount: 30n,
        limits: [
          { scope: "global", maxStroops: 1_000n, windowMs: DAY },
          // `a` is out of this window: 30 fits, where a day's 40 would not.
          { scope: `payer:${PAYER}`, maxStroops: 35n, windowMs: HOUR },
        ],
        now: 2 * HOUR,
      });
      expect(result).toEqual({
        reserved: true,
        usage: [
          { scope: "global", usedStroops: 40n, maxStroops: 1_000n, windowMs: DAY },
          { scope: `payer:${PAYER}`, usedStroops: 30n, maxStroops: 35n, windowMs: HOUR },
        ],
      });
    });

    describe("count limits (0107)", () => {
      const ACCOUNT = "account:discord:1" as const;
      /** At most `maxCount` of the account's reservations stamped at or after `since`. */
      const payments = (maxCount: number, since = 0): SpendLimit => ({
        scope: ACCOUNT,
        maxCount,
        since,
      });
      const global = (maxStroops = 1_000n): SpendLimit => ({
        scope: "global",
        maxStroops,
        windowMs: DAY,
      });
      const refusedBy = (scope: string, limit: "stroops" | "count") => ({
        reserved: false,
        scope,
        limit,
      });

      it("refuses the reservation past a count limit", async () => {
        const quota = [payments(2), global()];
        for (const id of ["a", "b"]) {
          expect(await store.reserve({ id, amount: 10n, limits: quota, now: 1 })).toMatchObject({
            reserved: true,
          });
        }
        expect(await store.reserve({ id: "c", amount: 10n, limits: quota, now: 2 })).toEqual(
          refusedBy(ACCOUNT, "count"),
        );
        // `c` reserved nothing, in no limit: its retry is refused again, not taken for a repeat.
        expect(await store.used("global", DAY, 2)).toBe(20n);
        expect(await store.used(ACCOUNT, DAY, 2)).toBe(20n);
        expect(await store.reserve({ id: "c", amount: 10n, limits: quota, now: 3 })).toEqual(
          refusedBy(ACCOUNT, "count"),
        );
        // A repeat of a reserved id is the no-op it always was, not refused by its own row.
        expect(await store.reserve({ id: "a", amount: 10n, limits: quota, now: 4 })).toEqual({
          reserved: true,
          usage: [],
        });
        expect(await store.used(ACCOUNT, DAY, 4)).toBe(20n);
      });

      it("a released reservation frees its count", async () => {
        const quota = [payments(2)];
        await store.reserve({ id: "a", amount: 10n, limits: quota, now: 1 });
        await store.reserve({ id: "b", amount: 10n, limits: quota, now: 1 });
        await store.release("a", 2);
        expect(await store.reserve({ id: "c", amount: 10n, limits: quota, now: 3 })).toMatchObject({
          reserved: true,
        });
      });

      it("a committed reservation keeps its count", async () => {
        const quota = [payments(2)];
        await store.reserve({ id: "a", amount: 10n, limits: quota, now: 1 });
        await store.reserve({ id: "b", amount: 10n, limits: quota, now: 1 });
        await store.commit("a", 5n);
        // A rewrap under someone else's fee bump commits 0: it was still a payment.
        await store.commit("b", 0n);
        // A late release can't hand a paid settlement back.
        await store.release("a", 2);
        expect(await store.reserve({ id: "c", amount: 10n, limits: quota, now: 3 })).toEqual(
          refusedBy(ACCOUNT, "count"),
        );
      });

      it("counts from since, inclusive", async () => {
        // The last millisecond of November counts in November only; the 1st of December at
        // 00:00:00.000 counts in December.
        const since = Date.UTC(2026, 11, 1);
        await store.reserve({ id: "before", amount: 1n, limits: [payments(10)], now: since - 1 });
        await store.reserve({ id: "at", amount: 1n, limits: [payments(10)], now: since });
        const later = since + 5;
        expect(
          await store.reserve({ id: "c", amount: 1n, limits: [payments(1, since)], now: later }),
        ).toEqual(refusedBy(ACCOUNT, "count"));
        expect(
          await store.reserve({
            id: "c",
            amount: 1n,
            limits: [payments(1, since + 1)],
            now: later,
          }),
        ).toMatchObject({ reserved: true });
        // `at` and `c` count from `since`, `before` doesn't: a third fits in 3.
        expect(
          await store.reserve({ id: "d", amount: 1n, limits: [payments(3, since)], now: later }),
        ).toMatchObject({ reserved: true });
      });

      it("a stroop refusal says limit: stroops", async () => {
        const quota = [payments(10), global(100n)];
        await store.reserve({ id: "a", amount: 60n, limits: quota, now: 1 });
        expect(await store.reserve({ id: "b", amount: 60n, limits: quota, now: 2 })).toEqual(
          refusedBy("global", "stroops"),
        );
      });

      it("an account's two limits on one scope", async () => {
        // One scope row, locked once, and one reservation row in it: two would fail the upsert
        // or the insert, or count the reservation twice.
        const fees: SpendLimit = { scope: ACCOUNT, maxStroops: 1_000n, windowMs: DAY };
        const quota = [payments(2), fees, global()];
        expect(await store.reserve({ id: "a", amount: 10n, limits: quota, now: 1 })).toEqual({
          reserved: true,
          usage: [
            { scope: ACCOUNT, usedStroops: 10n, maxStroops: 1_000n, windowMs: DAY },
            { scope: "global", usedStroops: 10n, maxStroops: 1_000n, windowMs: DAY },
          ],
        });
        expect(await store.reserve({ id: "b", amount: 10n, limits: quota, now: 1 })).toEqual({
          reserved: true,
          usage: [
            { scope: ACCOUNT, usedStroops: 20n, maxStroops: 1_000n, windowMs: DAY },
            { scope: "global", usedStroops: 20n, maxStroops: 1_000n, windowMs: DAY },
          ],
        });
        expect(await store.used(ACCOUNT, DAY, 1)).toBe(20n);
        expect(await store.reserve({ id: "c", amount: 10n, limits: quota, now: 2 })).toEqual(
          refusedBy(ACCOUNT, "count"),
        );
        // Both full: the refusal names the first in the limits' order.
        const full = { scope: ACCOUNT, maxStroops: 20n, windowMs: DAY };
        expect(
          await store.reserve({ id: "d", amount: 10n, limits: [payments(2), full], now: 2 }),
        ).toEqual(refusedBy(ACCOUNT, "count"));
        expect(
          await store.reserve({ id: "d", amount: 10n, limits: [full, payments(2)], now: 2 }),
        ).toEqual(refusedBy(ACCOUNT, "stroops"));
      });

      it("rejects a count limit with a bad maxCount or since, and changes nothing", async () => {
        const bad: SpendLimit[] = [
          ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((maxCount) => payments(maxCount)),
          // Untyped code's missing start: SQL NULL would match no row, so nothing would count.
          ...[undefined, null, 1.5].map((since) => ({
            scope: ACCOUNT,
            maxCount: 1,
            since: since as unknown as number,
          })),
        ];
        for (const limit of bad) {
          await expect(
            store.reserve({ id: "a", amount: 1n, limits: [limit, global()], now: 0 }),
          ).rejects.toBeInstanceOf(RangeError);
        }
        expect(await store.used("global", DAY, 0)).toBe(0n);
        expect(
          await store.reserve({ id: "a", amount: 1n, limits: [payments(0), global()], now: 0 }),
        ).toEqual(refusedBy(ACCOUNT, "count"));
      });
    });

    const backoff = { baseMs: 1_000, factor: 2, maxMs: 5_000, strikeResetMs: 100_000 };

    it("keeps each scope's failures and breaker apart", async () => {
      const [x, y] = ["asset:CX", "asset:CY"] as const;
      await store.recordFailure(x, 0, 60_000);
      await store.recordFailure(x, 1, 60_000);
      expect(await store.recordFailure(y, 2, 60_000)).toMatchObject({ failures: 1 });
      await store.recordSuccess(y, 3, 60_000);
      expect(await store.recordFailure(x, 3, 60_000)).toMatchObject({ failures: 3, successes: 0 });
      expect(await store.openBreaker(x, 4, backoff)).toBe(1_004);
      expect(await store.breakerOpenUntil(y, 5)).toBeUndefined();
      expect(await store.breakerOpenUntil(x, 5)).toBe(1_004);
    });

    it("counts failures within the window and restarts after it", async () => {
      const scope = "asset:CASSET" as const;
      expect(await store.recordFailure(scope, 0, 1_000)).toEqual({
        failures: 1,
        successes: 0,
        strikes: 0,
      });
      expect(await store.recordFailure(scope, 1_000, 1_000)).toMatchObject({ failures: 2 });
      // The window runs from its first event, not from the latest one.
      expect(await store.recordFailure(scope, 1_001, 1_000)).toMatchObject({ failures: 1 });
      expect(await store.recordFailure(scope, 2_000, 1_000)).toMatchObject({ failures: 2 });
    });

    it("counts successes without resetting failures, and restarts both with the window", async () => {
      const scope = "asset:CASSET" as const;
      await store.recordFailure(scope, 0, 1_000);
      await store.recordSuccess(scope, 1, 1_000);
      await store.recordSuccess(scope, 2, 1_000);
      expect(await store.recordFailure(scope, 3, 1_000)).toMatchObject({
        failures: 2,
        successes: 2,
      });
      // A success after the window ends starts the next one.
      await store.recordSuccess(scope, 1_001, 1_000);
      expect(await store.recordFailure(scope, 1_002, 1_000)).toMatchObject({
        failures: 1,
        successes: 1,
      });
    });

    it("opens a breaker until a time", async () => {
      const scope = "asset:CASSET" as const;
      expect(await store.breakerOpenUntil(scope, 0)).toBeUndefined();
      expect(await store.openBreaker(scope, 0, backoff)).toBe(1_000);
      expect(await store.breakerOpenUntil(scope, 999)).toBe(1_000);
      expect(await store.breakerOpenUntil(scope, 1_000)).toBeUndefined();
    });

    it("reports which of several scopes have an open breaker in one read", async () => {
      await store.openBreaker("payer:P", 0, backoff);
      await store.openBreaker("asset:CASSET", 0, backoff);
      expect(await store.breakersOpen(["payer:P", "payTo:S", "asset:CASSET"], 999)).toEqual(
        new Set(["payer:P", "asset:CASSET"]),
      );
      // Both close at baseMs; none is open after.
      expect(await store.breakersOpen(["payer:P", "asset:CASSET"], 1_000)).toEqual(new Set());
      expect(await store.breakersOpen([], 0)).toEqual(new Set());
    });

    it("opens for baseMs first, then base x factor, capped at maxMs", async () => {
      const scope = "asset:CASSET" as const;
      const ends: number[] = [];
      let now = 0;
      for (let i = 0; i < 6; i++) {
        const until = await store.openBreaker(scope, now, backoff);
        ends.push(until - now);
        now = until;
      }
      expect(ends).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
      expect(await store.recordFailure(scope, now, 1_000)).toMatchObject({ strikes: 6 });
    });

    it("returns an open breaker's end unchanged, with no new strike", async () => {
      const scope = "asset:CASSET" as const;
      expect(await store.openBreaker(scope, 0, backoff)).toBe(1_000);
      expect(await store.openBreaker(scope, 500, backoff)).toBe(1_000);
      expect(await store.recordFailure(scope, 500, 1_000)).toMatchObject({
        strikes: 1,
        lastOpenedAt: 0,
      });
      // Closed again, the next opening is the second strike.
      expect(await store.openBreaker(scope, 1_000, backoff)).toBe(3_000);
    });

    it("does not overflow on a huge strike count or factor", async () => {
      const scope = "asset:CASSET" as const;
      const wild = { baseMs: 1_000, factor: 1e6, maxMs: 7_000, strikeResetMs: 1e12 };
      let now = 0;
      for (let i = 0; i < 5; i++) now = await store.openBreaker(scope, now, wild);
      expect(now).toBe(1_000 + 4 * 7_000);
    });

    it("adds one strike when two instances open it together", async () => {
      const scope = "asset:CASSET" as const;
      const ends = await Promise.all([
        store.openBreaker(scope, 10, backoff),
        store.openBreaker(scope, 10, backoff),
        store.openBreaker(scope, 11, backoff),
      ]);
      expect(new Set(ends).size).toBe(1);
      expect(await store.recordFailure(scope, 12, 1_000)).toMatchObject({ strikes: 1 });
    });

    it("clears strikes after strikeResetMs without an opening", async () => {
      const scope = "asset:CASSET" as const;
      expect(await store.openBreaker(scope, 0, backoff)).toBe(1_000);
      expect(await store.openBreaker(scope, 1_000, backoff)).toBe(3_000);
      // Quiet for longer than strikeResetMs since the last opening: back to the first step.
      expect(await store.openBreaker(scope, 103_001, backoff)).toBe(104_001);
      expect(await store.recordFailure(scope, 103_002, 1_000)).toMatchObject({
        strikes: 1,
        lastOpenedAt: 103_001,
      });
    });

    it("leaves an open breaker as it is: its end, and its strikes", async () => {
      const scope = "asset:CASSET" as const;
      const long = { ...backoff, baseMs: 2_000 };
      expect(await store.openBreaker(scope, 0, long)).toBe(2_000);
      // A shorter opening while it is open neither moves its end earlier nor adds a strike.
      expect(await store.openBreaker(scope, 1_000, backoff)).toBe(2_000);
      expect(await store.breakerOpenUntil(scope, 1_500)).toBe(2_000);
      expect(await store.recordFailure(scope, 1_500, 1_000)).toMatchObject({ strikes: 1 });
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

    it("prunes windows that ended before a time, at most a limit at a time", async () => {
      await store.hit("a", 60_000, 0);
      await store.hit("b", 60_000, 1);
      await store.hit("c", 60_000, 60_000);
      // `a` and `b` end at 60 000, `c` at 120 000; a window ending at the cutoff is kept.
      expect(await store.prune(60_000, 10)).toBe(0);
      expect(await store.prune(60_001, 1)).toBe(1);
      expect(await store.prune(60_001, 10)).toBe(1);
      expect(await store.prune(60_001, 10)).toBe(0);
      // A pruned key starts a new window; a kept one goes on counting.
      expect(await store.hit("a", 60_000, 0)).toEqual({ count: 1, resetAt: 60_000 });
      expect(await store.hit("c", 60_000, 60_000)).toEqual({ count: 2, resetAt: 120_000 });
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
    const upsert = (
      entry: Omit<CatalogEntry, "keyVersion" | "ledger" | "checkedAt">,
      checkedAt = 1,
    ) => store.upsert({ keyVersion: CATALOG_KEY_VERSION, ledger: 1, checkedAt, ...entry });
    const key = (url: string, payTo = PAY_TO, network: StellarNetwork = "stellar:testnet") => ({
      network,
      payTo,
      method: "GET",
      resourceUrl: url,
    });

    it("stores an entry no settlement wrote, as the seed does (0155)", async () => {
      const url = "https://seller.example.com/seeded";
      const entry = { key: key(url), resource: resource(url) };
      expect(
        await store.upsert({
          keyVersion: CATALOG_KEY_VERSION,
          ledger: null,
          checkedAt: 1,
          ...entry,
        }),
      ).toBe("inserted");
      expect(await store.get(key(url))).toMatchObject({ resource: url });
    });

    it("replaces the stored entry by key, its accepts included (0063 row 7)", async () => {
      const url = "https://seller.example.com/data";
      await upsert({ key: key(url), resource: resource(url, { description: "old" }) });
      await upsert(
        {
          key: key(url),
          resource: resource(url, {
            description: "new",
            accepts: [requirements({ asset: "COTHER" })],
            lastUpdated: "2026-10-09T00:00:00.000Z",
          }),
        },
        2,
      );
      const page = await store.list({ limit: 10, offset: 0 }, Date.now());
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        description: "new",
        lastUpdated: "2026-10-09T00:00:00.000Z",
      });
      expect(page.items[0]?.accepts.map((a) => a.asset)).toEqual(["COTHER"]);
      // `get` gives the stored entry; `list` adds `curated` to it (0070).
      const { curated, ...stored } = page.items[0]!;
      expect(curated).toBe(false);
      expect(await store.get(key(url))).toEqual(stored);
      expect(await store.get(key("https://seller.example.com/none"))).toBeUndefined();
    });

    it("keeps the entry of the check that started later; an earlier one is stale (row 10)", async () => {
      const url = "https://seller.example.com/data";
      const at = (checkedAt: number, description: string) =>
        upsert({ key: key(url), resource: resource(url, { description }) }, checkedAt);
      expect(await at(10, "new")).toBe("inserted");
      expect(await at(10, "same start")).toBe("updated");
      expect(await at(9, "older")).toBe("stale");
      expect((await store.get(key(url)))?.description).toBe("same start");
      await expect(at(Number.NaN, "bad")).rejects.toThrow();
    });

    it("keeps the latest of concurrent upserts of one key", async () => {
      const url = "https://seller.example.com/data";
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          upsert({ key: key(url), resource: resource(url, { description: `d${i}` }) }, i),
        ),
      );
      const page = await store.list({ limit: 10, offset: 0 }, Date.now());
      expect(page.total).toBe(1);
      expect(page.items[0]?.description).toBe("d9");
    });

    it("refuses an offer that is not an upstream payment requirement (row 19)", async () => {
      const url = "https://seller.example.com/data";
      const bad = { ...requirements(), amount: 100 } as unknown as PaymentRequirements;
      await expect(
        upsert({ key: key(url), resource: resource(url, { accepts: [bad] }) }),
      ).rejects.toThrow();
      expect(await store.get(key(url))).toBeUndefined();
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
        (await store.list(query, Date.now())).items.map((item) => item.resource);
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
      const page = await store.list({ limit: 1, offset: 1 }, Date.now());
      expect(page).toMatchObject({ total: 3, items: [{ resource: "https://b.example" }] });
      expect(await store.list({ limit: 10, offset: 5 }, Date.now())).toEqual({
        items: [],
        total: 3,
      });
      expect(await store.list({ limit: 0, offset: 0 }, Date.now())).toEqual({
        items: [],
        total: 3,
      });
    });

    it("filters on the stored fields after an update, and after a stale write", async () => {
      const url = "https://seller.example.com/data";
      const at = (checkedAt: number, overrides: Partial<DiscoveryResource>) =>
        upsert({ key: key(url), resource: resource(url, overrides) }, checkedAt);
      await at(10, { type: "http", extensions: { bazaar: {} } });
      await at(10, { type: "mcp" });
      // A check that started earlier keeps the stored fields, and with them the filters.
      expect(await at(9, { type: "http", extensions: { bazaar: {} } })).toBe("stale");
      const total = async (query: Omit<Parameters<CatalogStore["list"]>[0], "limit" | "offset">) =>
        (await store.list({ ...query, limit: 10, offset: 0 }, Date.now())).total;
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
      const page = await store.list({ extensions: "bazaar", limit: 10, offset: 0 }, Date.now());
      expect(page.items.map((item) => item.resource)).toEqual(["https://object.example"]);
      expect(page.total).toBe(1);
      // An array's index is not an extension key either.
      expect(await store.list({ extensions: "0", limit: 10, offset: 0 }, Date.now())).toEqual({
        items: [],
        total: 0,
      });
    });
  });
}

export function catalogSearchContract(make: Make<CatalogStore>) {
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
  const upsert = (
    entry: Omit<CatalogEntry, "keyVersion" | "ledger" | "checkedAt">,
    checkedAt = 1,
  ) => store.upsert({ keyVersion: CATALOG_KEY_VERSION, ledger: 1, checkedAt, ...entry });
  const key = (url: string, payTo = PAY_TO, network: StellarNetwork = "stellar:testnet") => ({
    network,
    payTo,
    method: "GET",
    resourceUrl: url,
  });
  describe("CatalogStore search by words (0120, ADR 0014)", () => {
    type Search = Parameters<CatalogStore["search"]>[0];
    const search = (text: string, query: Partial<Search> = {}) =>
      store.search({ text, limit: 10, ...query }, Date.now());
    const urls = async (text: string, query: Partial<Search> = {}) =>
      (await search(text, query)).map((hit) => hit.resource.resource);
    const listing = (url: string, overrides: Partial<DiscoveryResource>) =>
      upsert({ key: key(url), resource: resource(url, overrides) });

    it("finds a listing as soon as the catalog stores it", async () => {
      await listing("https://a.example/x", { description: "weather" });
      expect(await urls("weather")).toEqual(["https://a.example/x"]);
    });

    it("finds a listing by any word of the query, and nothing when no listing holds one", async () => {
      await listing("https://a.example/x", { description: "Weather forecast for a city" });
      await listing("https://b.example/x", { description: "Stock prices" });
      expect(await urls("weather in paris")).toEqual(["https://a.example/x"]);
      expect(await urls("zebra")).toEqual([]);
      // Only stop words: no word to look for.
      expect(await urls("the of")).toEqual([]);
    });

    it("looks for the first 32 distinct words of a long query", async () => {
      await listing("https://a.example/x", { description: "w32" });
      await listing("https://b.example/x", { description: "w31" });
      const words = Array.from({ length: 33 }, (_, i) => `w${i}`);
      // Repeats don't count against the 32.
      expect(await urls(["w0", ...words].join(" "))).toEqual(["https://b.example/x"]);
    });

    it("ranks a word in the name above tags, then description, then parameters", async () => {
      await listing("https://params.example/x", {
        extensions: {
          bazaar: { info: { input: { type: "http", queryParams: { weather: "" } } } },
        },
      });
      await listing("https://description.example/x", { description: "weather" });
      await listing("https://tags.example/x", { tags: ["weather"] });
      await listing("https://name.example/x", { serviceName: "Weather" });
      expect(await urls("weather")).toEqual([
        "https://name.example/x",
        "https://tags.example/x",
        "https://description.example/x",
        "https://params.example/x",
      ]);
    });

    it("reads the name from the URL path and an MCP tool's name", async () => {
      await listing("https://a.example/v1/forecast?city=x", {});
      await listing("mcp://tool/lookup", {
        type: "mcp",
        extensions: { bazaar: { info: { input: { type: "mcp", toolName: "get_tides" } } } },
      });
      expect(await urls("forecast")).toEqual(["https://a.example/v1/forecast?city=x"]);
      expect(await urls("tides")).toEqual(["mcp://tool/lookup"]);
      // The query string is not part of the name.
      expect(await urls("city")).toEqual([]);
    });

    it("reads parameters' names and descriptions from the inputs and the schema", async () => {
      await listing("mcp://tool/a", {
        type: "mcp",
        extensions: {
          bazaar: {
            info: {
              input: {
                type: "mcp",
                toolName: "a",
                inputSchema: { properties: { zip: { description: "postal code" } } },
              },
            },
          },
        },
      });
      await listing("https://b.example/x", {
        extensions: {
          bazaar: {
            schema: {
              properties: {
                input: {
                  properties: {
                    body: { properties: { ticker: { description: "exchange symbol" } } },
                  },
                },
              },
            },
          },
        },
      });
      expect(await urls("postal")).toEqual(["mcp://tool/a"]);
      expect(await urls("zip")).toEqual(["mcp://tool/a"]);
      expect(await urls("exchange")).toEqual(["https://b.example/x"]);
      expect(await urls("ticker")).toEqual(["https://b.example/x"]);
    });

    it("stores a listing whose fields have unexpected shapes, and still finds it", async () => {
      await listing("https://odd.example/x", {
        description: "weather",
        extensions: {
          bazaar: { info: { input: "x" }, schema: { properties: { input: [] } } },
        } as unknown as DiscoveryResource["extensions"],
      });
      expect(await urls("weather")).toEqual(["https://odd.example/x"]);
    });

    it("filters before ranking, and searches both networks without a network filter", async () => {
      await upsert({
        key: key("https://a.example/x"),
        resource: resource("https://a.example/x", { description: "weather" }),
      });
      await upsert({
        key: key("https://b.example/x", "GOTHER"),
        resource: resource("https://b.example/x", { description: "weather", type: "mcp" }),
      });
      await upsert({
        key: key("https://c.example/x", PAY_TO, "stellar:pubnet"),
        resource: resource("https://c.example/x", { description: "weather" }),
      });
      expect((await urls("weather")).sort()).toEqual([
        "https://a.example/x",
        "https://b.example/x",
        "https://c.example/x",
      ]);
      expect(await urls("weather", { type: "mcp" })).toEqual(["https://b.example/x"]);
      expect(await urls("weather", { payTo: "GOTHER" })).toEqual(["https://b.example/x"]);
      expect(await urls("weather", { network: "stellar:pubnet" })).toEqual(["https://c.example/x"]);
      expect(await urls("weather", { network: "eip155:8453" })).toEqual([]);
    });

    it("orders equal ranks by key and pages after a result without a repeat or a gap", async () => {
      for (const host of ["e", "c", "a", "d", "b"])
        await listing(`https://${host}.example/x`, { description: "weather" });
      const seen: string[] = [];
      let after: Search["after"];
      for (let page = 0; page < 4; page++) {
        const hits = await search("weather", { limit: 2, after });
        seen.push(...hits.map((hit) => hit.resource.resource));
        if (hits.length < 2) break;
        const last = hits.at(-1)!;
        after = { rank: last.rank, key: last.key };
      }
      expect(seen).toEqual(["a", "b", "c", "d", "e"].map((host) => `https://${host}.example/x`));
    });

    it("pages from a higher rank to a lower one", async () => {
      await listing("https://name.example/x", { serviceName: "weather" });
      await listing("https://description.example/x", { description: "weather" });
      const [first] = await search("weather", { limit: 1 });
      expect(first?.resource.resource).toBe("https://name.example/x");
      const next = await urls("weather", { after: { rank: first!.rank, key: first!.key } });
      expect(next).toEqual(["https://description.example/x"]);
    });

    it("searches the stored listing's words after an update", async () => {
      const url = "https://a.example/x";
      await upsert({ key: key(url), resource: resource(url, { description: "weather" }) }, 1);
      await upsert({ key: key(url), resource: resource(url, { description: "stocks" }) }, 2);
      expect(await urls("weather")).toEqual([]);
      expect(await urls("stocks")).toEqual([url]);
    });
  });
}

export function catalogAttemptStoreContract(make: Make<CatalogAttemptStore>) {
  describe("CatalogAttemptStore contract (0063 row 23)", () => {
    let attempts: CatalogAttemptStore;
    beforeEach(async () => {
      attempts = await make();
    });

    const attempt = (at: number, overrides: Partial<CatalogAttempt> = {}): CatalogAttempt => ({
      at,
      network: "stellar:testnet",
      payTo: PAY_TO,
      payer: PAYER,
      stage: "payment",
      outcome: "rejected",
      ...overrides,
    });

    it("records an attempt with no payer, as the seed's checks are (0155)", async () => {
      await expect(attempts.record(attempt(1, { payer: undefined }))).resolves.toBeUndefined();
    });

    it("prunes attempts before a time in batches, keeping later ones", async () => {
      for (const at of [1, 2, 3, 10]) await attempts.record(attempt(at));
      await attempts.record(
        attempt(11, {
          key: {
            network: "stellar:testnet",
            payTo: PAY_TO,
            method: "GET",
            resourceUrl: "https://x.example/a",
          },
          url: "https://x.example/a?q=1",
          transaction: "tx",
          reason: "too_large",
          detail: "accepts.extra",
          fieldBytes: 5_000,
          contentHash: "ab".repeat(32),
        }),
      );
      expect(await attempts.prune(5, 2)).toBe(2);
      expect(await attempts.prune(5, 2)).toBe(1);
      expect(await attempts.prune(5, 2)).toBe(0);
    });
  });
}

export function searchCardStoreContract(
  make: Make<{ catalog: CatalogStore; cards: SearchCardStore }>,
) {
  describe("SearchCardStore contract (0120)", () => {
    let catalog: CatalogStore;
    let cards: SearchCardStore;
    beforeEach(async () => {
      ({ catalog, cards } = await make());
    });

    const list = (url: string, checkedAt: number, description = "") =>
      catalog.upsert({
        keyVersion: CATALOG_KEY_VERSION,
        ledger: null,
        checkedAt,
        key: { network: "stellar:testnet", payTo: PAY_TO, method: "GET", resourceUrl: url },
        resource: {
          resource: url,
          type: "http",
          x402Version: 2,
          accepts: [requirements()],
          lastUpdated: "2026-11-24T00:00:00.000Z",
          description,
        },
      });
    const urls = (page: CardListing[]) => page.map((listing) => listing.resource.resource);

    it("pages through every listing in catalog order", async () => {
      for (const host of ["a", "b", "c"]) await list(`https://${host}.example`, 1);
      const first = await cards.listings("0", 2);
      expect(urls(first)).toEqual(["https://a.example", "https://b.example"]);
      const second = await cards.listings(first[1]!.seq, 2);
      expect(urls(second)).toEqual(["https://c.example"]);
      expect(await cards.listings(second[0]!.seq, 2)).toEqual([]);
    });

    it("writes no card over one that already holds its text", async () => {
      await list("https://a.example", 1);
      const [listing] = await cards.listings("0", 10);
      // The catalog's write has already written this listing's card.
      expect(await cards.write(listing!)).toBe(false);
    });

    it("writes no card for a listing written again since it was read", async () => {
      await list("https://a.example", 1, "Weather");
      const [listing] = await cards.listings("0", 10);
      await list("https://a.example", 2, "Tides");
      expect(await cards.write(listing!)).toBe(false);
    });
  });
}

/** What the fused search contract needs: the catalog, and a way to store a card's vector. */
export interface MeaningFixture {
  catalog: CatalogStore;
  /** Stores a vector of `model` on the card of `key`'s listing, as the vector pass would. */
  setVector: (key: CatalogKey, model: string, vector: number[]) => Promise<void>;
}

/**
 * Search by words and by meaning, fused (0120 point G, ADR 0014). Needs the `vector` extension
 * (pgvector) in the test database. Every listing has a description on its own host and no
 * payments, so its quality factor is 1 and its rank is the fused score alone.
 */
export function catalogMeaningContract(make: Make<MeaningFixture>) {
  describe("CatalogStore search by meaning, fused with words (0120 G, ADR 0014; needs pgvector)", () => {
    let catalog: CatalogStore;
    let setVector: MeaningFixture["setVector"];
    beforeEach(async () => {
      ({ catalog, setVector } = await make());
    });
    type Search = Parameters<CatalogStore["search"]>[0];
    const key = (host: string, overrides: Partial<CatalogKey> = {}): CatalogKey => ({
      network: "stellar:testnet",
      payTo: PAY_TO,
      method: "GET",
      resourceUrl: `https://${host}.example/x`,
      ...overrides,
    });
    /** A listing at `k`, and its vector of cosine `cos` to the query unless `cos` is null. */
    const listing = async (
      k: CatalogKey,
      fields: Partial<DiscoveryResource>,
      cos: number | null,
      model: string = catalog.searchModel,
      checkedAt = 1,
    ) => {
      await catalog.upsert({
        keyVersion: CATALOG_KEY_VERSION,
        ledger: 1,
        checkedAt,
        key: k,
        resource: {
          resource: k.resourceUrl,
          type: "http",
          x402Version: 2,
          accepts: [requirements({ network: k.network, payTo: k.payTo })],
          lastUpdated: "2026-11-24T00:00:00.000Z",
          ...fields,
        },
      });
      if (cos !== null) await setVector(k, model, unitVector(cos));
    };
    const fused = (text: string, query: Partial<Search> = {}) =>
      catalog.search(
        {
          text,
          limit: 100,
          meaning: QUERY_VECTOR,
          ...query,
        } as Search,
        Date.now(),
      );
    const hosts = (hits: { resource: DiscoveryResource }[]) =>
      hits.map((hit) => new URL(hit.resource.resource).hostname.split(".")[0]);
    /** The fused score of 0120 point G; a missing rank adds no term. */
    const score = (byMeaning?: number, byWords?: number) =>
      (byMeaning === undefined ? 0 : 4 / (20 + byMeaning)) +
      (byWords === undefined ? 0 : 1 / (20 + byWords));
    const weatherParameter = {
      extensions: { bazaar: { info: { input: { type: "http", queryParams: { weather: "" } } } } },
    } as Partial<DiscoveryResource>;

    it("scores each match 4/(20 + rank by meaning) + 1/(20 + rank by words), ranks from 1 (G)", async () => {
      await listing(key("a"), { tags: ["weather"], description: "Rain and sun" }, 0.95);
      await listing(key("b"), { description: "Tides and waves" }, 0.9);
      await listing(key("c"), { description: "weather" }, 0.7);
      await listing(key("e"), { description: "Stock prices" }, 0.61);
      await listing(key("h"), { description: "Bond yields" }, 0.59);
      // Not matches: no vector, and a vector of another model, though both hold the word.
      await listing(key("f"), { description: "Fog", ...weatherParameter }, null);
      await listing(key("g"), { description: "Gale", ...weatherParameter }, 0.99, "old-model");
      const hits = await fused("weather");
      expect(hosts(hits)).toEqual(["a", "c", "b", "e"]);
      expect(hits.map((hit) => Number(hit.rank))).toEqual([
        expect.closeTo(score(1, 1), 6),
        expect.closeTo(score(3, 2), 6),
        expect.closeTo(score(2), 6),
        expect.closeTo(score(4), 6),
      ]);
    });

    it("ranks by the first 32 distinct words of a long query only (G)", async () => {
      await listing(key("a"), { description: "w32" }, 0.9);
      await listing(key("b"), { description: "w31" }, 0.8);
      const words = Array.from({ length: 33 }, (_, i) => `w${i}`);
      // Repeats don't count against the 32: w31 is a word looked for, w32 is not.
      const hits = await fused(["w0", ...words].join(" "));
      expect(hosts(hits)).toEqual(["b", "a"]);
      expect(hits.map((hit) => Number(hit.rank))).toEqual([
        expect.closeTo(score(2, 1), 6),
        expect.closeTo(score(1), 6),
      ]);
    });

    it("matches by meaning at a cosine of 0.60 or more, not below (G)", async () => {
      await listing(key("above"), { description: "Tides" }, 0.61);
      await listing(key("below"), { description: "Waves" }, 0.59);
      // "zebra" is in no listing, so only meaning can match.
      const hits = await fused("zebra");
      expect(hosts(hits)).toEqual(["above"]);
      expect(Number(hits[0]!.rank)).toBeCloseTo(score(1), 6);
    });

    it("finds nothing when no listing is close in meaning or holds a word (G)", async () => {
      await listing(key("a"), { description: "Tides" }, 0.3);
      expect(await fused("zebra")).toEqual([]);
    });

    // ADR 0014, "Matches": words never add a listing; they only order the listings that match.
    it("returns no listing whose meaning is below 0.60, though it holds a query word (G)", async () => {
      await listing(key("b"), { description: "Tides" }, 0.9);
      await listing(key("d"), { serviceName: "Weather", description: "Sea level" }, 0.3);
      const hits = await fused("weather");
      expect(hosts(hits)).toEqual(["b"]);
      expect(Number(hits[0]!.rank)).toBeCloseTo(score(1), 6);
    });

    it("returns no listing without a vector of the current model, whatever its words (G)", async () => {
      await listing(key("n"), { serviceName: "Weather", description: "Now" }, null);
      await listing(key("o"), { serviceName: "Weather", description: "Old" }, 0.99, "old-model");
      await listing(key("m"), { description: "weather" }, 0.7);
      expect(hosts(await fused("weather"))).toEqual(["m"]);
    });

    it("counts the ranks by words among the matches only (G)", async () => {
      // Three listings rank above m by words, but none is a match: two have no current vector,
      // and d's meaning is below 0.60.
      await listing(key("n"), { serviceName: "Weather", description: "Now" }, null);
      await listing(key("o"), { serviceName: "Weather", description: "Old" }, 0.99, "old-model");
      await listing(key("d"), { serviceName: "Weather", description: "Sea level" }, 0.3);
      await listing(key("m"), { description: "weather" }, 0.7);
      const [hit] = await fused("weather");
      expect(Number(hit!.rank)).toBeCloseTo(score(1, 1), 6);
    });

    it("orders equal scores by key: network, payTo, method, resource URL (G)", async () => {
      const keys = [
        key("b", { method: "GET" }),
        key("a", { method: "POST" }),
        key("z", { payTo: "GA" }),
        key("a"),
        key("a", { network: "stellar:pubnet" }),
      ];
      for (const k of keys) await listing(k, { description: "Tides" }, 0.8);
      const hits = await fused("zebra");
      expect(hits.map((hit) => hit.key)).toEqual([
        key("a", { network: "stellar:pubnet" }),
        key("z", { payTo: "GA" }),
        key("a"),
        key("b"),
        key("a", { method: "POST" }),
      ]);
    });

    it("pages after a result without a repeat or a gap, and reaches every match: nothing is cut (G)", async () => {
      // 60 matches, more than the top 50 a cut would keep, five of them tied.
      for (let i = 0; i < 60; i++) {
        const cos = i < 5 ? 0.9 : 0.95 - i * 0.005;
        await listing(key(`h${String(i).padStart(2, "0")}`), { description: "Tides" }, cos);
      }
      const all = await fused("zebra");
      expect(all).toHaveLength(60);
      const seen: string[] = [];
      let after: Search["after"];
      for (let page = 0; page < 20; page++) {
        const hits = await fused("zebra", { limit: 7, after });
        seen.push(...hits.map((hit) => hit.resource.resource));
        if (hits.length < 7) break;
        const last = hits.at(-1)!;
        after = { rank: last.rank, key: last.key };
      }
      expect(seen).toEqual(all.map((hit) => hit.resource.resource));
    });

    it("filters before ranking, so ranks count among the listings that pass (G)", async () => {
      await listing(key("a"), { description: "Tides" }, 0.95);
      await listing(key("p", { network: "stellar:pubnet" }), { description: "Waves" }, 0.7);
      await listing(key("t"), { description: "Swell", type: "mcp" }, 0.65);
      const pubnet = await fused("zebra", { network: "stellar:pubnet" });
      expect(hosts(pubnet)).toEqual(["p"]);
      expect(Number(pubnet[0]!.rank)).toBeCloseTo(score(1), 6);
      expect(hosts(await fused("zebra", { type: "mcp" }))).toEqual(["t"]);
      expect(hosts(await fused("zebra", { network: "eip155:8453" }))).toEqual([]);
    });

    it("says a listing that passes the filters waits for a vector of the model (ADR 0014)", async () => {
      const waiting = (network?: string) =>
        catalog.waitingForVector({ text: "x", limit: 10, network });
      await listing(key("a"), { description: "Tides" }, 0.9);
      expect(await waiting()).toBe(false);
      await listing(key("b"), { description: "Waves" }, null);
      expect(await waiting()).toBe(true);
      // The network filter leaves b out; a vector of another model waits like none.
      const pubnet = key("c", { network: "stellar:pubnet" });
      await listing(pubnet, { description: "Stocks" }, 0.9);
      expect(await waiting("stellar:pubnet")).toBe(false);
      await listing(key("d", { network: "stellar:pubnet" }), { description: "Bonds" }, 0.9, "old");
      expect(await waiting("stellar:pubnet")).toBe(true);
    });

    it("leaves out a listing whose text changed until its new vector is written (G, ADR 0014)", async () => {
      await listing(key("a"), { description: "Tides" }, 0.9);
      await listing(key("a"), { description: "Waves" }, null, catalog.searchModel, 2);
      expect(hosts(await fused("zebra"))).toEqual([]);
    });

    it("ranks by words alone without a query vector, listings without a vector included (H)", async () => {
      await listing(key("n"), { description: "weather" }, null);
      expect(hosts(await catalog.search({ text: "weather", limit: 10 }, Date.now()))).toEqual([
        "n",
      ]);
    });
  });
}

/** What the quality contract needs: the catalog, its vectors, and the settlements of one database. */
export interface QualityFixture extends MeaningFixture {
  settlements: SettlementStore;
  /** The stellar.toml proofs (0070), whose curated listings get ×1.1. */
  curation: CurationStore;
}

const DAY_MS = 86_400_000;
/**
 * The search's clock in the quality cases, far from the database's own clock: a count that read
 * the database clock instead of `now` would count other payments.
 */
const QUALITY_NOW = Date.UTC(2030, 0, 1);

/** q of ADR 0014's "Quality score": p paying wallets, a tunnel host, an empty description. */
const qualityFactor = (p: number, tunnel = false, empty = false) =>
  (1 + (0.2 * p) / (p + 2)) * (tunnel ? 0.9 : 1) * (empty ? 0.9 : 1);

/** The tunnel hosts of ADR 0014's "Quality score". */
const TUNNEL_HOSTS = [
  "trycloudflare.com",
  "ts.net",
  "serveo.net",
  "serveousercontent.com",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok-free.dev",
  "loca.lt",
  "lhr.life",
  "lhr.rocks",
  "pinggy.link",
  "pinggy-free.link",
];

/**
 * The quality factor q on search (0154, ADR 0014 "Quality score"): every final score is the base
 * score times q, in the words ranking and in the fused one. Payments go through the settlement
 * store as `/settle` writes them: a claim naming the listing, then the final state.
 */
export function catalogQualityContract(make: Make<QualityFixture>) {
  describe("CatalogStore search quality factor (0154, ADR 0014; fused cases need pgvector)", () => {
    let catalog: CatalogStore;
    let settlements: SettlementStore;
    let curation: CurationStore;
    let setVector: MeaningFixture["setVector"];
    let nonce = 0;
    beforeEach(async () => {
      ({ catalog, settlements, curation, setVector } = await make());
    });
    /** `k`'s host and payTo proved, or disproved, by stellar.toml (0070), in a check at `checkedAt`. */
    const curate = (k: CatalogKey, curated = true, checkedAt = QUALITY_NOW) =>
      curation.put({
        network: k.network,
        host: new URL(k.resourceUrl).hostname,
        payTo: k.payTo,
        curated,
        checkedAt,
      });
    type Search = Parameters<CatalogStore["search"]>[0];
    type Hit = Awaited<ReturnType<CatalogStore["search"]>>[number];

    const key = (url: string, overrides: Partial<CatalogKey> = {}): CatalogKey => ({
      network: "stellar:testnet",
      payTo: PAY_TO,
      method: "GET",
      resourceUrl: url,
      ...overrides,
    });
    /** A listing at `k` with one offer to its network and payTo, and a vector of cosine `cos`. */
    const listing = async (
      k: CatalogKey,
      fields: Partial<DiscoveryResource> = {},
      cos: number | null = null,
    ) => {
      await catalog.upsert({
        keyVersion: CATALOG_KEY_VERSION,
        ledger: 1,
        checkedAt: 1,
        key: k,
        resource: {
          resource: k.resourceUrl,
          type: "http",
          x402Version: 2,
          accepts: [requirements({ network: k.network, payTo: k.payTo })],
          lastUpdated: "2026-11-26T00:00:00.000Z",
          ...fields,
        },
      });
      if (cos !== null) await setVector(k, catalog.searchModel, unitVector(cos));
    };

    type Ending = "success" | "claimed" | "signed" | "pending" | "failed" | "rejected" | "expired";
    interface Payment {
      /** A wallet of its own per payment unless given. */
      payer?: string;
      createdAt?: number;
      ending?: Ending | "refused";
      /** Fields of the payment's requirements other than the listing's offer. */
      terms?: Partial<PaymentRequirements>;
      /** The listing the settlement names; `null` names none. Default: `k`'s. */
      names?: { method: string; resourceUrl: string } | null;
    }
    /** A settlement paying for `k`'s listing, written as `/settle` writes it. */
    const pay = async (k: CatalogKey, payment: Payment = {}) => {
      const n = String(++nonce);
      const network = k.network;
      const payer = payment.payer ?? `GWALLET${n}`;
      const accepted = requirements({ network, payTo: k.payTo, ...payment.terms });
      const names =
        payment.names === undefined
          ? { method: k.method, resourceUrl: k.resourceUrl }
          : (payment.names ?? undefined);
      const s: NewSettlement = {
        key: `${network}:${payer}:${n}` as SettlementKey,
        network,
        payer,
        nonce: n,
        fingerprint: `fp-${n}`,
        paymentPayload: { x402Version: 2, accepted, payload: { tx: "AAAA" } },
        paymentRequirements: accepted,
        createdAt: payment.createdAt ?? QUALITY_NOW - DAY_MS,
        ...(names === undefined ? {} : { listing: names }),
      };
      const ending = payment.ending ?? "success";
      if (ending === "refused") {
        await settlements.refuse(s, { errorReason: "invalid_payload" }, [], s.createdAt);
        return;
      }
      expect(await settlements.claim(s)).toMatchObject({ claimed: true });
      if (ending === "claimed") return;
      if (ending === "signed") {
        expect(
          await settlements.addHash(s.key, `h${n}`, await holdLease(settlements), s.createdAt),
        ).toBe(true);
        return;
      }
      const update = {
        state: ending,
        updatedAt: s.createdAt,
        ...(ending === "success" || ending === "pending" ? {} : { errorReason: "x" }),
      };
      expect(await settlements.transition(s.key, "claimed", update)).toMatchObject({
        state: ending,
      });
    };
    /** `count` payments of `k`, each by a wallet of its own. */
    const payByWallets = async (k: CatalogKey, count: number) => {
      for (let i = 0; i < count; i++) await pay(k);
    };

    const words = (text: string, query: Partial<Search> = {}, now = QUALITY_NOW) =>
      catalog.search({ text, limit: 100, ...query }, now);
    const fused = (text: string, query: Partial<Search> = {}) =>
      catalog.search({ text, limit: 100, meaning: QUERY_VECTOR, ...query }, QUALITY_NOW);
    const urlsOf = (hits: Hit[]) => hits.map((hit) => hit.resource.resource);
    const hitOf = (hits: Hit[], url: string) => {
      const hit = hits.find((h) => h.key.resourceUrl === url);
      if (hit === undefined) throw new Error(`no hit for ${url}`);
      return hit;
    };
    const round6 = (q: number) => Math.round(q * 1e6) / 1e6;
    /**
     * Each hit's rank over the base listing's, rounded to 6 places: words ranks are PostgreSQL
     * `real`, and every listing here has the same base rank, so the ratio is the hit's q.
     */
    const ratios = (hits: Hit[], baseUrl: string) => {
      const base = Number(hitOf(hits, baseUrl).rank);
      return Object.fromEntries(
        hits.map((hit) => [
          `${hit.key.network === "stellar:pubnet" ? "pubnet " : ""}${hit.key.resourceUrl}`,
          round6(Number(hit.rank) / base),
        ]),
      );
    };
    /** The fused score of 0120 point G, as in the meaning contract. */
    const score = (byMeaning?: number, byWords?: number) =>
      (byMeaning === undefined ? 0 : 4 / (20 + byMeaning)) +
      (byWords === undefined ? 0 : 1 / (20 + byWords));
    /** Every listing matches "weather" in its description, so words ranks them equal. */
    const WEATHER = { description: "weather" };
    const BASE = "https://base.example/x";

    describe("by words", () => {
      it("multiplies the rank by q = 1 + 0.2 p / (p + 2): 1 wallet ×1.0667, 10 ×1.1667, none ×1", async () => {
        await listing(key(BASE), WEATHER);
        await listing(key("https://one.example/x"), WEATHER);
        await listing(key("https://ten.example/x"), WEATHER);
        await payByWallets(key("https://one.example/x"), 1);
        await payByWallets(key("https://ten.example/x"), 10);
        const hits = await words("weather");
        expect(urlsOf(hits)).toEqual(["https://ten.example/x", "https://one.example/x", BASE]);
        expect(ratios(hits, BASE)).toEqual({
          "https://ten.example/x": round6(qualityFactor(10)),
          "https://one.example/x": round6(qualityFactor(1)),
          [BASE]: 1,
        });
        expect(qualityFactor(1)).toBeCloseTo(1.0667, 4);
        expect(qualityFactor(10)).toBeCloseTo(1.1667, 4);
      });

      it("counts only success settlements: claimed, signed, pending, failed, rejected, expired and refused ones don't", async () => {
        const k = key("https://paid.example/x");
        await listing(key(BASE), WEATHER);
        await listing(k, WEATHER);
        await pay(k);
        for (const ending of [
          "claimed",
          "signed",
          "pending",
          "failed",
          "rejected",
          "expired",
          "refused",
        ] as const)
          await pay(k, { ending });
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(1)),
        });
      });

      it("counts distinct wallets, not payments: a wallet paying three times counts once", async () => {
        const k = key("https://paid.example/x");
        await listing(key(BASE), WEATHER);
        await listing(k, WEATHER);
        for (let i = 0; i < 3; i++) await pay(k, { payer: "GREPEAT" });
        await pay(k, { payer: "GONCE" });
        // p = 2 (q 1.1), not 4 payments (q 1.1333).
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(2)),
        });
      });

      it("never counts a seller paying its own payTo (task AC3)", async () => {
        const self = key("https://self.example/x");
        const mixed = key("https://mixed.example/x");
        await listing(key(BASE), WEATHER);
        await listing(self, WEATHER);
        await listing(mixed, WEATHER);
        await pay(self, { payer: PAY_TO });
        await pay(mixed, { payer: PAY_TO });
        await pay(mixed, { payer: "GBUYER" });
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          [self.resourceUrl]: 1,
          [mixed.resourceUrl]: round6(qualityFactor(1)),
        });
      });

      it("counts the 30 days that end at the search's now: exactly 30 days old counts, 1 ms older does not", async () => {
        const k = key("https://paid.example/x");
        await listing(key(BASE), WEATHER);
        await listing(k, WEATHER);
        await pay(k, { createdAt: QUALITY_NOW - 30 * DAY_MS });
        await pay(k, { createdAt: QUALITY_NOW - 30 * DAY_MS - 1 });
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(1)),
        });
        // One ms later the payment of exactly 30 days is out too: the window moves with `now`.
        expect(ratios(await words("weather", {}, QUALITY_NOW + 1), BASE)).toMatchObject({
          [k.resourceUrl]: 1,
        });
      });

      it("counts a payment for the listing it names: method and URL, network and payTo all equal", async () => {
        const k = key("https://paid.example/x");
        await listing(key(BASE), WEATHER);
        await listing(k, WEATHER);
        await pay(k);
        // Another method, another URL, no listing named, another payTo.
        await pay(k, { names: { method: "POST", resourceUrl: k.resourceUrl } });
        await pay(k, { names: { method: "GET", resourceUrl: "https://paid.example/y" } });
        await pay(k, { names: null });
        await pay(key(k.resourceUrl, { payTo: "GOTHER" }));
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(1)),
        });
      });

      it("counts each network's own payments, testnet as pubnet", async () => {
        const url = "https://paid.example/x";
        const testnet = key(url);
        const pubnet = key(url, { network: "stellar:pubnet" });
        await listing(key(BASE), WEATHER);
        await listing(testnet, WEATHER);
        await listing(pubnet, WEATHER);
        await payByWallets(testnet, 1);
        await payByWallets(pubnet, 3);
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          [url]: round6(qualityFactor(1)),
          [`pubnet ${url}`]: round6(qualityFactor(3)),
        });
      });

      it("counts a payment only when its scheme, network, payTo, asset and amount equal one stored offer's", async () => {
        const k = key("https://paid.example/x");
        await listing(key(BASE), WEATHER);
        const offer = requirements({ asset: "CASSET", amount: "1000" });
        const second = requirements({ asset: "CSECOND", amount: "5000" });
        await listing(k, { ...WEATHER, accepts: [offer, second] });
        await pay(k, { terms: { asset: "CASSET", amount: "1000" } });
        // Differs only in fields not compared: still counts.
        await pay(k, {
          terms: { asset: "CASSET", amount: "1000", maxTimeoutSeconds: 300, extra: { a: 1 } },
        });
        // The second offer counts as well.
        await pay(k, { terms: { asset: "CSECOND", amount: "5000" } });
        // A dust amount, another asset, another scheme, and fields of two offers mixed: none.
        await pay(k, { terms: { asset: "CASSET", amount: "1" } });
        await pay(k, { terms: { asset: "COTHER", amount: "1000" } });
        await pay(k, { terms: { asset: "CASSET", amount: "1000", scheme: "upto" } });
        await pay(k, { terms: { asset: "CASSET", amount: "5000" } });
        // The requirements on another network than the settlement's, which names the listing.
        await pay(k, { terms: { asset: "CASSET", amount: "1000", network: "stellar:pubnet" } });
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(3)),
        });
      });

      it("stops counting payments on terms the listing no longer offers, and counts them again when it offers them again", async () => {
        const k = key("https://paid.example/x");
        await listing(key(BASE), WEATHER);
        const offerAt = (amount: string, checkedAt: number) =>
          catalog.upsert({
            keyVersion: CATALOG_KEY_VERSION,
            ledger: 1,
            checkedAt,
            key: k,
            resource: {
              resource: k.resourceUrl,
              type: "http",
              x402Version: 2,
              accepts: [requirements({ network: k.network, payTo: k.payTo, amount })],
              lastUpdated: "2026-11-26T00:00:00.000Z",
              ...WEATHER,
            },
          });
        expect(await offerAt("1000", 1)).toBe("inserted");
        await pay(k, { terms: { amount: "1000" } });
        await pay(k, { terms: { amount: "1000" } });
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(2)),
        });
        // The seller raises the price: the two payments match no offer now.
        expect(await offerAt("2000", 2)).toBe("updated");
        expect(ratios(await words("weather"), BASE)).toMatchObject({ [k.resourceUrl]: 1 });
        // The old price returns: nothing was erased, they count again.
        expect(await offerAt("1000", 3)).toBe("updated");
        expect(ratios(await words("weather"), BASE)).toMatchObject({
          [k.resourceUrl]: round6(qualityFactor(2)),
        });
      });

      it("lowers a listing on a tunnel host ×0.9: each of the 13, a subdomain of one, with a port", async () => {
        await listing(key(BASE), WEATHER);
        const urls = [
          ...TUNNEL_HOSTS.map((host) => `https://x.${host}/x`),
          "https://ts.net/x",
          "https://ngrok.io/x",
          "https://a.b.trycloudflare.com/x",
          "https://x.ngrok.io:8443/a",
        ];
        for (const url of urls) await listing(key(url), WEATHER);
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          ...Object.fromEntries(urls.map((url) => [url, 0.9])),
        });
      });

      it("gives no penalty to a host that only ends in a tunnel's letters or to shared hosting", async () => {
        await listing(key(BASE), WEATHER);
        const urls = [
          "https://getbits.net/x",
          "https://notts.net/x",
          "https://seller.workers.dev/x",
          "https://x.vercel.app/x",
          "https://ngrok.io.example/x",
        ];
        for (const url of urls) await listing(key(url), WEATHER);
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          ...Object.fromEntries(urls.map((url) => [url, 1])),
        });
      });

      it("lowers a listing whose search card has no description ×0.9: missing, empty or spaces; a short one or an MCP tool's is no penalty", async () => {
        const tags = { tags: ["weather"] };
        await listing(key(BASE), { ...tags, description: "Rain and sun" });
        await listing(key("https://missing.example/x"), tags);
        await listing(key("https://empty.example/x"), { ...tags, description: "" });
        await listing(key("https://spaces.example/x"), { ...tags, description: "   " });
        await listing(key("https://short.example/x"), { ...tags, description: "ok" });
        await listing(key("mcp://tool/tides"), {
          ...tags,
          type: "mcp",
          extensions: {
            bazaar: {
              info: { input: { type: "mcp", toolName: "tides", description: "Tide tables" } },
            },
          },
        });
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          "https://missing.example/x": 0.9,
          "https://empty.example/x": 0.9,
          "https://spaces.example/x": 0.9,
          "https://short.example/x": 1,
          "mcp://tool/tides": 1,
        });
      });

      it("multiplies the factors: tunnel and empty description ×0.81, with 10 wallets ×0.945", async () => {
        await listing(key(BASE), WEATHER);
        await listing(key("https://x.ts.net/x"), { tags: ["weather"] });
        await listing(key("https://y.ts.net/x"), { tags: ["weather"] });
        await listing(key("https://z.example/x"), { tags: ["weather"], description: "Rain" });
        await payByWallets(key("https://y.ts.net/x"), 10);
        const hits = await words("weather");
        // Tags rank differently from a description: compare with the listing tagged alike.
        const tagged = Number(hitOf(hits, "https://z.example/x").rank);
        expect(Number(hitOf(hits, "https://x.ts.net/x").rank) / tagged).toBeCloseTo(0.81, 6);
        expect(Number(hitOf(hits, "https://y.ts.net/x").rank) / tagged).toBeCloseTo(
          qualityFactor(10, true, true),
          6,
        );
      });

      it("orders by the final score, and pages with `after` through every match once, in order", async () => {
        const p = [0, 3, 1, 5, 2, 0];
        for (const [i, count] of p.entries()) {
          const k = key(`https://h${i}.example/x`);
          await listing(k, WEATHER);
          await payByWallets(k, count);
        }
        await listing(key("https://t.ts.net/x"), WEATHER);
        const all = await words("weather");
        expect(urlsOf(all)).toEqual([
          "https://h3.example/x",
          "https://h1.example/x",
          "https://h4.example/x",
          "https://h2.example/x",
          "https://h0.example/x",
          "https://h5.example/x",
          "https://t.ts.net/x",
        ]);
        const seen: Hit[] = [];
        let after: Search["after"];
        for (let page = 0; page < 10; page++) {
          const hits = await words("weather", { limit: 2, after });
          seen.push(...hits);
          if (hits.length < 2) break;
          const last = hits.at(-1)!;
          after = { rank: last.rank, key: last.key };
        }
        expect(seen).toEqual(all);
      });
    });

    describe("fused, by meaning and words", () => {
      it("multiplies the fused score by q, counting positions before q: 10 wallets lift the 4th by meaning past the 1st", async () => {
        const hosts = ["a", "b", "c", "d"];
        for (const [i, host] of hosts.entries())
          await listing(
            key(`https://${host}.example/x`),
            { description: "Tides" },
            0.95 - i * 0.05,
          );
        await payByWallets(key("https://d.example/x"), 10);
        // "zebra" is in no listing: meaning alone ranks.
        const hits = await fused("zebra");
        expect(urlsOf(hits)).toEqual(
          ["d", "a", "b", "c"].map((host) => `https://${host}.example/x`),
        );
        expect(hits.map((hit) => Number(hit.rank))).toEqual([
          expect.closeTo(score(4) * qualityFactor(10), 6),
          expect.closeTo(score(1), 6),
          expect.closeTo(score(2), 6),
          expect.closeTo(score(3), 6),
        ]);
      });

      it("multiplies both terms, meaning's and words', by q", async () => {
        // a: 1st by meaning, 2nd by words. b: 2nd by meaning, 1st by words (tags), 1 wallet.
        await listing(key("https://a.example/x"), { description: "weather" }, 0.95);
        await listing(key("https://b.example/x"), { tags: ["weather"], description: "Tides" }, 0.9);
        await payByWallets(key("https://b.example/x"), 1);
        const hits = await fused("weather");
        expect(urlsOf(hits)).toEqual(["https://b.example/x", "https://a.example/x"]);
        expect(hits.map((hit) => Number(hit.rank))).toEqual([
          expect.closeTo(score(2, 1) * qualityFactor(1), 6),
          expect.closeTo(score(1, 2), 6),
        ]);
      });

      it("applies the tunnel and empty description penalties to the fused score", async () => {
        await listing(key("https://x.ts.net/x"), { description: "Tides" }, 0.95);
        await listing(key("https://getbits.net/x"), { description: "Waves" }, 0.9);
        await listing(key("https://c.example/x"), {}, 0.85);
        await listing(key("https://y.trycloudflare.com/x"), { description: " " }, 0.8);
        const hits = await fused("zebra");
        expect(urlsOf(hits)).toEqual([
          "https://getbits.net/x",
          "https://x.ts.net/x",
          "https://c.example/x",
          "https://y.trycloudflare.com/x",
        ]);
        expect(hits.map((hit) => Number(hit.rank))).toEqual([
          expect.closeTo(score(2), 6),
          expect.closeTo(score(1) * 0.9, 6),
          expect.closeTo(score(3) * 0.9, 6),
          expect.closeTo(score(4) * 0.81, 6),
        ]);
      });

      it("pages with `after` through every match once, in the order of the final score", async () => {
        for (let i = 0; i < 12; i++) {
          const k = key(`https://h${String(i).padStart(2, "0")}.example/x`);
          await listing(k, { description: "Tides" }, 0.95 - i * 0.02);
          await payByWallets(k, i % 4);
        }
        const all = await fused("zebra");
        expect(all).toHaveLength(12);
        const ranks = all.map((hit) => Number(hit.rank));
        expect(ranks).toEqual([...ranks].sort((x, y) => y - x));
        const seen: Hit[] = [];
        let after: Search["after"];
        for (let page = 0; page < 10; page++) {
          const hits = await fused("zebra", { limit: 5, after });
          seen.push(...hits);
          if (hits.length < 5) break;
          const last = hits.at(-1)!;
          after = { rank: last.rank, key: last.key };
        }
        expect(seen).toEqual(all);
      });
    });

    describe("curated (0070)", () => {
      it("multiplies a curated listing's q by 1.1, within q's cap of 1.2", async () => {
        const urls = ["curated", "one", "ten", "disproved"].map(
          (name) => `https://${name}.example/x`,
        );
        await listing(key(BASE), WEATHER);
        for (const url of urls) await listing(key(url), WEATHER);
        const tunnel = key("https://x.ts.net/x");
        await listing(tunnel, WEATHER);
        for (const url of ["curated", "one", "ten"]) await curate(key(`https://${url}.example/x`));
        await curate(tunnel);
        await curate(key("https://disproved.example/x"), false);
        await payByWallets(key("https://one.example/x"), 1);
        await payByWallets(key("https://ten.example/x"), 10);
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          "https://curated.example/x": 1.1,
          "https://one.example/x": round6(qualityFactor(1) * 1.1),
          // 1.1667 × 1.1 = 1.2833, held at the cap.
          "https://ten.example/x": 1.2,
          "https://disproved.example/x": 1,
          "https://x.ts.net/x": round6(1.1 * 0.9),
        });
      });

      it("multiplies the fused score by 1.1 too", async () => {
        await listing(key("https://a.example/x"), { description: "Tides" }, 0.95);
        await listing(key("https://b.example/x"), { description: "Tides" }, 0.9);
        await curate(key("https://b.example/x"));
        const hits = await fused("zebra");
        expect(urlsOf(hits)).toEqual(["https://b.example/x", "https://a.example/x"]);
        expect(hits.map((hit) => Number(hit.rank))).toEqual([
          expect.closeTo(score(2) * 1.1, 6),
          expect.closeTo(score(1), 6),
        ]);
      });

      it("counts a proof checked 29 days ago, and not one checked 31 days ago", async () => {
        const recent = key("https://recent.example/x");
        const old = key("https://old.example/x");
        await listing(key(BASE), WEATHER, 0.95);
        await listing(recent, WEATHER, 0.95);
        await listing(old, WEATHER, 0.95);
        await curate(recent, true, QUALITY_NOW - 29 * DAY_MS);
        await curate(old, true, QUALITY_NOW - 31 * DAY_MS);
        expect(ratios(await words("weather"), BASE)).toEqual({
          [BASE]: 1,
          [recent.resourceUrl]: 1.1,
          [old.resourceUrl]: 1,
        });
        // Equal by meaning and by words, the fused positions go by key: base, old, recent.
        expect(
          (await fused("weather")).map((hit) => [hit.key.resourceUrl, Number(hit.rank)]),
        ).toEqual([
          [recent.resourceUrl, expect.closeTo(score(3, 3) * 1.1, 6)],
          [BASE, expect.closeTo(score(1, 1), 6)],
          [old.resourceUrl, expect.closeTo(score(2, 2), 6)],
        ]);
        const curated = (resources: ListedResource[]) =>
          Object.fromEntries(resources.map((resource) => [resource.resource, resource.curated]));
        const listed = { [BASE]: false, [recent.resourceUrl]: true, [old.resourceUrl]: false };
        expect(curated((await words("weather")).map((hit) => hit.resource))).toEqual(listed);
        expect(curated((await fused("weather")).map((hit) => hit.resource))).toEqual(listed);
        expect(curated((await catalog.list({ limit: 10, offset: 0 }, QUALITY_NOW)).items)).toEqual(
          listed,
        );
      });

      it("gives no bonus on another network's record", async () => {
        await listing(key(BASE), WEATHER);
        const k = key("https://curated.example/x");
        await listing(k, WEATHER);
        await curate({ ...k, network: "stellar:pubnet" });
        expect(ratios(await words("weather"), BASE)["https://curated.example/x"]).toBe(1);
      });
    });

    it("task AC2: of two listings matching a query equally, the one with paying wallets ranks first", async () => {
      // Without q, equal scores go by key: unpaid's URL sorts first.
      const unpaid = key("https://a-unpaid.example/x");
      const paid = key("https://b-paid.example/x");
      await listing(unpaid, WEATHER, 0.9);
      await listing(paid, WEATHER, 0.9);
      await payByWallets(paid, 2);
      expect(urlsOf(await words("weather"))).toEqual([paid.resourceUrl, unpaid.resourceUrl]);
      expect(urlsOf(await fused("weather"))).toEqual([paid.resourceUrl, unpaid.resourceUrl]);
    });
  });
}
