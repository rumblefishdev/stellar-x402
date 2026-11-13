import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { FailureCause } from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import type { SettlementRecord, SpendScope, SpendStore } from "../src/ports/index.js";
import type { BeforeSubmitContext } from "../src/settlement/hooks.js";
import { SETTLE_REASONS } from "../src/settlement/reasons.js";
import type { AssetKind, AssetKinds } from "../src/spend/asset-kinds.js";
import { budgetKind, spendLimits, type SpendBudgets } from "../src/spend/limits.js";
import {
  BREAKERS,
  createSpendPolicy,
  reservationId,
  verifyWithBreakers,
  type BalanceFloor,
} from "../src/spend/policy.js";
import { testDatabase } from "./database.js";

const db = testDatabase();
beforeEach(db.empty);

const network = "stellar:testnet";
const account = () => Keypair.random().publicKey();
const contract = () => StrKey.encodeContract(Keypair.random().rawPublicKey());
const USDC = contract();
const WINDOW_MS = 86_400_000;
const CEILING = 250_000n;
const backoff = { baseMs: 3_600_000, factor: 4, maxMs: 86_400_000, strikeResetMs: 86_400_000 };

const budgets: SpendBudgets = {
  windowMs: WINDOW_MS,
  globalStroops: 500_000_000n,
  perPayerStroops: 20_000_000n,
  perPayToStroops: 100_000_000n,
  perKnownAssetStroops: 250_000_000n,
  perOtherAssetStroops: 20_000_000n,
  tierOtherStroops: 100_000_000n,
};

/**
 * Known tier for USDC only; `kinds` says which other assets are wasm (SAC by default). Every kind
 * is `confirmed` unless named in `unconfirmed`, which models a read that an RPC error defaulted.
 */
function fakeAssets(
  kinds: Record<string, AssetKind> = {},
  unconfirmed: Iterable<string> = [],
): AssetKinds {
  const un = new Set(unconfirmed);
  return {
    tier: (asset) => (asset === USDC ? "known" : "other"),
    kind: async (asset) => kinds[asset] ?? "sac",
    confirmed: (asset) => !un.has(asset),
  };
}

let nonce = 0;
function context(overrides: Partial<BeforeSubmitContext> = {}): BeforeSubmitContext {
  const payer = overrides.payer ?? account();
  return {
    key: `${network}:${payer}:${++nonce}`,
    network,
    payer,
    payTo: account(),
    asset: USDC,
    amount: 1_000n,
    maxFeeStroops: CEILING,
    paymentPayload: {} as PaymentPayload,
    paymentRequirements: {} as PaymentRequirements,
    reopened: 0,
    now: 1_000_000,
    deadline: 1_005_000,
    ...overrides,
  };
}

function setup(
  overrides: {
    store?: SpendStore;
    assets?: AssetKinds;
    floor?: BalanceFloor;
    budgets?: SpendBudgets;
  } = {},
) {
  const store = overrides.store ?? db.stores().spend;
  const lines: string[] = [];
  const metrics = memoryMetrics();
  const clock = { now: 1_000_000 };
  const sleeps: number[] = [];
  const policy = createSpendPolicy({
    store,
    assets: overrides.assets ?? fakeAssets(),
    floor: overrides.floor ?? { below: () => false },
    budgets: overrides.budgets ?? budgets,
    logger: jsonLogger("debug", (line) => lines.push(line)),
    metrics,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  const events = (name: string) =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((l) => l.event === name);
  return { policy, store, metrics, lines, events, clock, sleeps };
}

/** `store` with some methods replaced; the others keep it as `this`. */
const overriding = (store: SpendStore, methods: Partial<SpendStore>): SpendStore =>
  Object.assign(Object.create(store) as SpendStore, methods);

/** The real store, whose `reserve` rejects `failures` times, after landing first if `lands`. */
function failingStore(failures: number, lands = false) {
  const real = db.stores().spend;
  const ids: string[] = [];
  let left = failures;
  const store = overriding(real, {
    reserve: async (reservation) => {
      ids.push(reservation.id);
      if (left > 0) {
        if (lands && left === failures) await real.reserve(reservation);
        left--;
        throw new Error("connection timeout");
      }
      return real.reserve(reservation);
    },
  });
  return { store, ids, real };
}

const used = (store: SpendStore, scope: SpendScope) => store.used(scope, WINDOW_MS, 1_000_000 + 1);

describe("spendLimits", () => {
  it("orders a known asset's limits payer, payTo, asset, global", () => {
    const ctx = { payer: "GP", payTo: "GT", asset: "CA" };
    expect(spendLimits(ctx, "known", budgets)).toEqual([
      { scope: "payer:GP", maxStroops: 20_000_000n, windowMs: WINDOW_MS },
      { scope: "payTo:GT", maxStroops: 100_000_000n, windowMs: WINDOW_MS },
      { scope: "asset:CA", maxStroops: 250_000_000n, windowMs: WINDOW_MS },
      { scope: "global", maxStroops: 500_000_000n, windowMs: WINDOW_MS },
    ]);
  });

  it("keys another token's payer and payTo by asset and adds tier:other before global", () => {
    const ctx = { payer: "GP", payTo: "GT", asset: "CA" };
    expect(spendLimits(ctx, "other", budgets)).toEqual([
      { scope: "payer:GP/CA", maxStroops: 20_000_000n, windowMs: WINDOW_MS },
      { scope: "payTo:GT/CA", maxStroops: 100_000_000n, windowMs: WINDOW_MS },
      { scope: "asset:CA", maxStroops: 20_000_000n, windowMs: WINDOW_MS },
      { scope: "tier:other", maxStroops: 100_000_000n, windowMs: WINDOW_MS },
      { scope: "global", maxStroops: 500_000_000n, windowMs: WINDOW_MS },
    ]);
  });

  it("names each scope's budget kind", () => {
    expect(
      (
        [
          "global",
          "tier:other",
          "payer:GP",
          "payer:GP/CA",
          "payTo:GT",
          "payTo:GT/CA",
          "asset:CA",
        ] as const
      ).map(budgetKind),
    ).toEqual(["global", "other", "payer", "payer", "pay_to", "pay_to", "asset"]);
  });
});

describe("createSpendPolicy beforeSubmit", () => {
  it("reserves the ceiling against payer, payTo, asset and global for USDC", async () => {
    const { policy, store } = setup();
    const ctx = context();

    expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
    for (const scope of [
      `payer:${ctx.payer}`,
      `payTo:${ctx.payTo}`,
      `asset:${USDC}`,
      "global",
    ] as const)
      expect(await used(store, scope)).toBe(CEILING);
    expect(await used(store, "tier:other")).toBe(0n);
    expect(await used(store, `payer:${ctx.payer}/${USDC}`)).toBe(0n);
  });

  it("adds tier:other and keys the payer and payTo by asset for another token", async () => {
    const { policy, store } = setup();
    const token = contract();
    const ctx = context({ asset: token });

    expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
    for (const scope of [
      `payer:${ctx.payer}/${token}`,
      `payTo:${ctx.payTo}/${token}`,
      `asset:${token}`,
      "tier:other",
      "global",
    ] as const)
      expect(await used(store, scope)).toBe(CEILING);
    // A seller's own token can't use up the buyer's USDC budget, nor a junk token a seller's.
    expect(await used(store, `payer:${ctx.payer}`)).toBe(0n);
    expect(await used(store, `payTo:${ctx.payTo}`)).toBe(0n);
  });

  it.each<[string, Partial<SpendBudgets>, string, string]>([
    ["payer", { perPayerStroops: 0n }, USDC, SETTLE_REASONS.spendLimitPayer],
    ["payTo", { perPayToStroops: 0n }, USDC, SETTLE_REASONS.spendLimitPayTo],
    ["known asset", { perKnownAssetStroops: 0n }, USDC, SETTLE_REASONS.spendLimitAsset],
    ["other asset", { perOtherAssetStroops: 0n }, "other", SETTLE_REASONS.spendLimitAsset],
    ["tier:other", { tierOtherStroops: 0n }, "other", SETTLE_REASONS.spendLimitOther],
    ["global", { globalStroops: 0n }, USDC, SETTLE_REASONS.spendLimitGlobal],
    [
      "the narrowest of several",
      { perPayToStroops: 0n, globalStroops: 0n },
      USDC,
      SETTLE_REASONS.spendLimitPayTo,
    ],
  ])(
    "refuses with the narrowest budget's reason and submits nothing: %s",
    async (_name, over, asset, reason) => {
      const { policy, store, metrics } = setup({ budgets: { ...budgets, ...over } });
      const ctx = context({ asset: asset === "other" ? contract() : asset });

      expect(await policy.beforeSubmit(ctx)).toEqual({ allow: false, errorReason: reason });
      expect(await used(store, "global")).toBe(0n);
      expect(metrics.value("spend_refused_total", { reason })).toBe(1);
    },
  );

  it("refuses below the balance floor before reserving", async () => {
    const { policy, store, metrics } = setup({ floor: { below: () => true } });

    expect(await policy.beforeSubmit(context())).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.facilitatorUnderfunded,
    });
    expect(await used(store, "global")).toBe(0n);
    expect(
      metrics.value("spend_refused_total", { reason: SETTLE_REASONS.facilitatorUnderfunded }),
    ).toBe(1);
  });

  it("refuses an open payer, payTo or wasm-asset breaker before reserving", async () => {
    const wasm = contract();
    const sac = contract();
    const { policy, store } = setup({ assets: fakeAssets({ [wasm]: "wasm" }) });
    const now = 1_000_000;

    const payerCtx = context();
    await store.openBreaker(`payer:${payerCtx.payer}`, now, backoff);
    const otherPayerCtx = context({ asset: wasm });
    // Another token's payer breaker is keyed by asset, like its budget.
    await store.openBreaker(`payer:${otherPayerCtx.payer}/${wasm}`, now, backoff);
    const payToCtx = context();
    await store.openBreaker(`payTo:${payToCtx.payTo}`, now, backoff);
    const wasmCtx = context({ asset: wasm });
    const bothCtx = context({ payer: payerCtx.payer, payTo: payToCtx.payTo });
    await store.openBreaker(`asset:${wasm}`, now, backoff);
    await store.openBreaker(`asset:${sac}`, now, backoff);

    expect(await policy.beforeSubmit(payerCtx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.breakerOpenPayer,
    });
    expect(await policy.beforeSubmit(otherPayerCtx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.breakerOpenPayer,
    });
    expect(await policy.beforeSubmit(payToCtx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.breakerOpenPayTo,
    });
    expect(await policy.beforeSubmit(wasmCtx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.breakerOpenAsset,
    });
    // The payer's breaker is named first.
    expect(await policy.beforeSubmit(bothCtx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.breakerOpenPayer,
    });
    expect(await used(store, "global")).toBe(0n);

    // A SAC never has a refusing breaker, and the payer's USDC breaker doesn't cover another asset.
    expect(await policy.beforeSubmit(context({ asset: sac }))).toEqual({ allow: true });
    expect(
      await policy.breakerRefusal({ payer: payerCtx.payer, payTo: account(), asset: sac }, now),
    ).toBeUndefined();
    expect(
      await policy.breakerRefusal({ payer: account(), payTo: account(), asset: wasm }, now),
    ).toBe(SETTLE_REASONS.breakerOpenAsset);

    // payTo's breaker is keyed by tier too: its USDC one doesn't cover another token, nor back.
    const token = contract();
    expect(
      await policy.breakerRefusal({ payer: account(), payTo: payToCtx.payTo, asset: token }, now),
    ).toBeUndefined();
    const seller = account();
    await store.openBreaker(`payTo:${seller}/${token}`, now, backoff);
    expect(
      await policy.breakerRefusal({ payer: account(), payTo: seller, asset: token }, now),
    ).toBe(SETTLE_REASONS.breakerOpenPayTo);
    expect(
      await policy.breakerRefusal({ payer: account(), payTo: seller, asset: USDC }, now),
    ).toBeUndefined();
  });

  it("retries a rejected reserve with the same id and allows once it lands", async () => {
    const { store, ids } = failingStore(2);
    const { policy, metrics, sleeps } = setup({ store });
    const ctx = context();

    expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
    const id = reservationId(ctx.key, ctx.reopened);
    expect(ids).toEqual([id, id, id]);
    expect(sleeps).toEqual([200, 200]);
    expect(metrics.value("spend_store_failures_total", { op: "reserve" })).toBe(2);
    expect(await used(store, "global")).toBe(CEILING);
  });

  it("resolves a lost COMMIT by the retry without counting it twice", async () => {
    const { store, ids } = failingStore(1, true);
    const { policy } = setup({ store });
    const ctx = context();

    expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
    const id = reservationId(ctx.key, ctx.reopened);
    expect(ids).toEqual([id, id]);
    expect(await used(store, "global")).toBe(CEILING);
    expect(await used(store, `payer:${ctx.payer}`)).toBe(CEILING);
  });

  it("refuses spend_store_unavailable past the deadline and leaves nothing counted", async () => {
    // The first attempt lands but its answer is lost; every later one fails.
    const { store, ids, real } = failingStore(Infinity, true);
    const { policy, metrics, sleeps, events } = setup({ store });
    const ctx = context({ deadline: 1_001_000 });

    expect(await policy.beforeSubmit(ctx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.spendStoreUnavailable,
    });
    // Attempts at 0, 200, 400, 600 and 800 ms; one more would end past the deadline.
    expect(ids).toHaveLength(5);
    expect(sleeps).toEqual([200, 200, 200, 200]);
    expect(metrics.value("spend_store_failures_total", { op: "reserve" })).toBe(5);
    expect(events("spend_store_failed")).toHaveLength(5);
    expect(await used(real, "global")).toBe(0n);
    expect(await used(real, `payer:${ctx.payer}`)).toBe(0n);
    // Released, so a reserve that arrives late counts nothing.
    const id = reservationId(ctx.key, ctx.reopened);
    expect(await real.reserve({ id, amount: CEILING, limits: [], now: ctx.now })).toEqual({
      reserved: false,
      released: true,
    });
  });

  it("still refuses spend_store_unavailable when the release fails too", async () => {
    const { store } = failingStore(Infinity);
    const s = setup({
      store: overriding(store, {
        release: async () => {
          throw new Error("down");
        },
      }),
    });

    const { policy, metrics } = s;
    expect(await policy.beforeSubmit(context({ deadline: 1_000_100 }))).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.spendStoreUnavailable,
    });
    expect(metrics.value("spend_store_failures_total", { op: "reserve" })).toBe(1);
    expect(metrics.value("spend_store_failures_total", { op: "release" })).toBe(1);
  });

  it("refuses spend_store_unavailable when a breaker can't be read, before reserving", async () => {
    const real = db.stores().spend;
    const { policy, metrics } = setup({
      store: overriding(real, {
        breakersOpen: async () => {
          throw new Error("down");
        },
      }),
    });

    expect(await policy.beforeSubmit(context())).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.spendStoreUnavailable,
    });
    expect(metrics.value("spend_store_failures_total", { op: "breaker" })).toBe(1);
    expect(await used(real, "global")).toBe(0n);
  });

  it("keeps a reopened claim's reservation apart from the earlier claim's (0073)", async () => {
    const { policy, store, metrics } = setup();
    const first = context();
    const reopened = { ...first, reopened: 1 };
    expect(await policy.beforeSubmit(first)).toEqual({ allow: true });
    expect(await policy.beforeSubmit(reopened)).toEqual({ allow: true });

    // The first claim's `onFinal` isn't awaited, so it lands after the reopened claim reserved,
    // and across processes it can repeat. It gives up only its own reservation.
    await policy.onFinal(finalRecord(first, "rejected"), "settle");
    await policy.onFinal(finalRecord(first, "rejected"), "resolved");
    expect(await used(store, "global")).toBe(CEILING);

    // Refused per claim: the first claim's late reserve stays out.
    expect(await policy.beforeSubmit(first)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.refused,
    });
    expect(await policy.beforeSubmit(reopened)).toEqual({ allow: true });
    expect(await used(store, "global")).toBe(CEILING);

    await policy.onFinal(finalRecord(reopened, "success"), "settle");
    expect(await used(store, "global")).toBe(14_278n);
    expect(metrics.value("spend_commit_unmatched_total", { state: "success" })).toBe(0);
  });

  it("refuses an id that was released, as the record is already final", async () => {
    const { policy, store } = setup();
    const ctx = context();
    await store.release(reservationId(ctx.key, ctx.reopened), ctx.now);

    expect(await policy.beforeSubmit(ctx)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.refused,
    });
    expect(await used(store, "global")).toBe(0n);
  });

  it("emits spend_budget_nearing once per scope at 80 %", async () => {
    // Eight ceilings fill the payer's budget to 80 %; the others stay below it.
    const { policy, metrics, events } = setup({
      budgets: { ...budgets, perPayerStroops: 10n * CEILING },
    });
    const payer = account();
    const pay = (now: number) => policy.beforeSubmit(context({ payer, now }));

    for (let i = 0; i < 7; i++) expect(await pay(1_000_000)).toEqual({ allow: true });
    expect(events("spend_budget_nearing")).toHaveLength(0);

    expect(await pay(1_000_000)).toEqual({ allow: true });
    expect(events("spend_budget_nearing")).toEqual([
      expect.objectContaining({
        level: "warn",
        scope: `payer:${payer}`,
        used: String(8n * CEILING),
        max: String(10n * CEILING),
        windowMs: WINDOW_MS,
      }),
    ]);
    expect(metrics.value("spend_budget_nearing_total", { budget: "payer" })).toBe(1);

    // Within the 15 min cooldown nothing more; past it the scope emits again.
    expect(await pay(1_000_000 + 899_999)).toEqual({ allow: true });
    expect(events("spend_budget_nearing")).toHaveLength(1);
    expect(await pay(1_000_000 + 900_000)).toEqual({ allow: true });
    expect(events("spend_budget_nearing")).toHaveLength(2);
    expect(metrics.value("spend_budget_nearing_total", { budget: "payer" })).toBe(2);

    // Another payer on the same policy is another scope: the first one's cooldown, still
    // running, doesn't hold back its report.
    const other = account();
    for (let i = 0; i < 8; i++) {
      const ctx = context({ payer: other, now: 1_000_000 + 900_001 });
      expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
    }
    expect(events("spend_budget_nearing").at(-1)).toMatchObject({ scope: `payer:${other}` });
    expect(metrics.value("spend_budget_nearing_total", { budget: "payer" })).toBe(3);
  });

  it("forgets the oldest scope's report past 10,000 scopes", async () => {
    let next: SpendScope = "global";
    const store = overriding(db.stores().spend, {
      breakersOpen: async () => new Set<SpendScope>(),
      reserve: async () => ({
        reserved: true,
        usage: [{ scope: next, usedStroops: 8n, maxStroops: 10n }],
      }),
    });
    const { policy, metrics } = setup({ store });
    const ctx = context();
    const report = async (scope: SpendScope) => {
      next = scope;
      await policy.beforeSubmit(ctx);
    };

    for (let i = 0; i <= 10_000; i++) await report(`payer:G${i}`);
    expect(metrics.value("spend_budget_nearing_total", { budget: "payer" })).toBe(10_001);
    // The first scope was forgotten, so it reports again; the second is still remembered.
    await report("payer:G0");
    expect(metrics.value("spend_budget_nearing_total", { budget: "payer" })).toBe(10_002);
    await report("payer:G2");
    expect(metrics.value("spend_budget_nearing_total", { budget: "payer" })).toBe(10_002);
  });
});

/** The final record of `ctx`'s settlement; a `failed` one is charged `fee` unless overridden. */
function finalRecord(
  ctx: BeforeSubmitContext,
  state: SettlementRecord["state"],
  overrides: Partial<SettlementRecord> = {},
): SettlementRecord {
  return {
    key: ctx.key,
    network,
    payer: ctx.payer,
    nonce: String(nonce),
    fingerprint: "f",
    state,
    hashes: ["tx1"],
    version: 0,
    reopened: ctx.reopened,
    paymentPayload: {} as PaymentPayload,
    paymentRequirements: { payTo: ctx.payTo, asset: ctx.asset } as PaymentRequirements,
    ...(state === "success" || state === "failed" ? { feeCharged: 14_278n, ledger: 100 } : {}),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...overrides,
  };
}

/** `store` that notes the scope of every breaker write. */
function spyingStore(store: SpendStore) {
  const writes: string[] = [];
  const spied = overriding(store, {
    recordFailure: (scope, now, windowMs) => {
      writes.push(`failure ${scope}`);
      return store.recordFailure(scope, now, windowMs);
    },
    recordSuccess: (scope, now, windowMs) => {
      writes.push(`success ${scope}`);
      return store.recordSuccess(scope, now, windowMs);
    },
    openBreaker: (scope, now, backoff) => {
      writes.push(`open ${scope}`);
      return store.openBreaker(scope, now, backoff);
    },
  });
  return { store: spied, writes };
}

/** A SAC's own error 10 (insufficient balance) from `asset`: the payer's fault. */
const balanceError = (asset: string): FailureCause => ({
  opCode: "invokeHostFunctionTrapped",
  error: { type: "sceContract", code: "10" },
  contract: asset,
});

const HOUR = 3_600_000;

describe("createSpendPolicy onFinal", () => {
  it("commits the fee charged for success and failed, releases otherwise", async () => {
    const { policy, store, metrics } = setup();
    const settled = async (state: SettlementRecord["state"], fee?: bigint) => {
      const ctx = context();
      expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
      await policy.onFinal(
        finalRecord(ctx, state, fee === undefined ? {} : { feeCharged: fee }),
        "settle",
      );
      return ctx;
    };

    const success = await settled("success", 14_278n);
    const failed = await settled("failed", 9_000n);
    expect(await used(store, `payer:${success.payer}`)).toBe(14_278n);
    expect(await used(store, `payer:${failed.payer}`)).toBe(9_000n);
    expect(await used(store, `payTo:${failed.payTo}`)).toBe(9_000n);

    for (const state of ["rejected", "expired"] as const) {
      const ctx = await settled(state);
      expect(await used(store, `payer:${ctx.payer}`)).toBe(0n);
    }
    // A failed record the network didn't charge is released too, and reaches no breaker.
    const uncharged = context();
    expect(await policy.beforeSubmit(uncharged)).toEqual({ allow: true });
    await policy.onFinal(
      finalRecord(uncharged, "failed", { feeCharged: undefined, failure: balanceError(USDC) }),
      "resolved",
    );
    expect(await used(store, `payer:${uncharged.payer}`)).toBe(0n);
    expect(await used(store, "global")).toBe(14_278n + 9_000n);

    // A record whose reservation was never made leaves a tombstone, so a late reserve counts nothing.
    const late = context();
    await policy.onFinal(finalRecord(late, "rejected"), "settle");
    expect(await policy.beforeSubmit(late)).toEqual({
      allow: false,
      errorReason: SETTLE_REASONS.refused,
    });
    expect(await used(store, "global")).toBe(14_278n + 9_000n);
    expect(metrics.value("spend_commit_unmatched_total", { state: "success" })).toBe(0);
  });

  it("logs and counts a commit that matched no reservation", async () => {
    const { policy, store, metrics, events } = setup();
    const ctx = context();

    await policy.onFinal(finalRecord(ctx, "success"), "resolved");

    expect(events("spend_commit_unmatched")).toEqual([
      expect.objectContaining({ level: "error", key: ctx.key, state: "success" }),
    ]);
    expect(metrics.value("spend_commit_unmatched_total", { state: "success" })).toBe(1);
    expect(await used(store, "global")).toBe(0n);
  });

  it("opens the payer breaker on the third attributed failure in an hour", async () => {
    const { policy, store, metrics, events, clock } = setup();
    const payer = account();
    const fail = (asset = USDC) => {
      const ctx = context({ payer, asset });
      return policy.onFinal(finalRecord(ctx, "failed", { failure: balanceError(asset) }), "settle");
    };

    // Two, then the window ends: the third one an hour later starts a new window.
    await fail();
    clock.now += 600_000;
    await fail();
    clock.now += HOUR;
    await fail();
    expect(await store.breakerOpenUntil(`payer:${payer}`, clock.now)).toBeUndefined();

    await fail();
    expect(await store.breakerOpenUntil(`payer:${payer}`, clock.now)).toBeUndefined();
    await fail();
    expect(await store.breakerOpenUntil(`payer:${payer}`, clock.now)).toBe(clock.now + HOUR);
    expect(events("spend_breaker_opened")).toEqual([
      expect.objectContaining({ scope: `payer:${payer}`, until: clock.now + HOUR }),
    ]);
    expect(metrics.value("spend_breaker_opened_total", { breaker: "payer" })).toBe(1);
    expect(metrics.value("spend_failure_attributed_total", { fault: "payer" })).toBe(5);
    // Its budget's key: another token's failures count in the payer's scope for that token.
    const token = contract();
    for (let i = 0; i < 3; i++) await fail(token);
    expect(await store.breakerOpenUntil(`payer:${payer}/${token}`, clock.now)).toBe(
      clock.now + HOUR,
    );
  });

  it("opens the payTo breaker on the third failure the recipient caused", async () => {
    const { policy, store, metrics } = setup();
    const payTo = account();
    const fail = async () => {
      const ctx = context({ payTo });
      const failure: FailureCause = {
        error: { type: "sceContract", code: "13" },
        contract: USDC,
        data: [USDC, payTo],
      };
      await policy.onFinal(finalRecord(ctx, "failed", { failure }), "settle");
      return ctx;
    };

    const first = await fail();
    await fail();
    expect(await store.breakerOpenUntil(`payTo:${payTo}`, 1_000_000)).toBeUndefined();
    await fail();
    expect(await store.breakerOpenUntil(`payTo:${payTo}`, 1_000_000)).toBe(1_000_000 + HOUR);
    expect(metrics.value("spend_breaker_opened_total", { breaker: "pay_to" })).toBe(1);
    expect(metrics.value("spend_failure_attributed_total", { fault: "pay_to" })).toBe(3);
    expect(await store.breakerOpenUntil(`payer:${first.payer}`, 1_000_000)).toBeUndefined();
  });

  it("blames the payer, not payTo, for a payTo error in another token", async () => {
    const spy = spyingStore(db.stores().spend);
    const { policy, store } = setup({ store: spy.store });
    // A SAC anyone can deploy over a classic asset they issue, and then deauthorize payTo in.
    const token = contract();
    const payTo = account();
    for (let i = 0; i < 3; i++) {
      const ctx = context({ payTo, asset: token });
      const failure: FailureCause = {
        error: { type: "sceContract", code: "13" },
        contract: token,
        data: [token, payTo],
      };
      await policy.onFinal(finalRecord(ctx, "failed", { failure }), "settle");
    }

    expect(spy.writes.filter((w) => w.includes("payTo:"))).toEqual([]);
    expect(await store.breakerOpenUntil(`payTo:${payTo}`, 1_000_000)).toBeUndefined();
    expect(await store.breakerOpenUntil(`payTo:${payTo}/${token}`, 1_000_000)).toBeUndefined();
  });

  it("opens it on the first failure in a C-account payer's own frame", async () => {
    const { policy, store, metrics } = setup();
    const fail = async (payer: string, failure: FailureCause) => {
      const ctx = context({ payer });
      await policy.onFinal(finalRecord(ctx, "failed", { failure }), "settle");
      return store.breakerOpenUntil(`payer:${payer}`, 1_000_000);
    };
    const auth: FailureCause = { error: { type: "sceAuth", code: "scecInvalidAction" } };

    const wallet = contract();
    const inFrame: FailureCause = {
      error: { type: "sceAuth", code: "scecInvalidAction" },
      contract: wallet,
    };
    expect(await fail(wallet, inFrame)).toBe(1_000_000 + HOUR);
    const other = contract();
    const trapped: FailureCause = { error: { type: "sceContract", code: "1" }, contract: other };
    expect(await fail(other, trapped)).toBe(1_000_000 + HOUR);
    expect(metrics.value("spend_breaker_opened_total", { breaker: "payer" })).toBe(2);

    // An auth error outside its frame (a C-account's or a G-account's), or a C-account's balance
    // error, takes three.
    const elsewhere = contract();
    expect(await fail(elsewhere, auth)).toBeUndefined();
    expect(await fail(elsewhere, auth)).toBeUndefined();
    expect(await fail(elsewhere, auth)).toBe(1_000_000 + HOUR);
    expect(await fail(account(), auth)).toBeUndefined();
    expect(await fail(contract(), balanceError(USDC))).toBeUndefined();
  });

  it("feeds no breaker for a front-run payload, and still commits its fee", async () => {
    const spy = spyingStore(db.stores().spend);
    const { policy, store, metrics } = setup({ store: spy.store });
    const wallet = contract();
    // The seller submitted the payload first: our transaction finds the nonce already used.
    const reused: FailureCause = {
      opCode: "invokeHostFunctionTrapped",
      error: { type: "sceAuth", code: "scecExistingValue" },
      contract: USDC,
    };
    const payTo = account();
    for (const payer of [wallet, wallet, wallet, account()]) {
      const ctx = context({ payer, payTo });
      expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });
      await policy.onFinal(finalRecord(ctx, "failed", { failure: reused }), "settle");
    }

    expect(spy.writes).toEqual([]);
    expect(await store.breakerOpenUntil(`payer:${wallet}`, 1_000_000)).toBeUndefined();
    expect(await used(store, `payer:${wallet}`)).toBe(3n * 14_278n);
    expect(await used(store, `payTo:${payTo}`)).toBe(4n * 14_278n);
    expect(metrics.value("spend_failure_attributed_total", { fault: "payer" })).toBe(0);
  });

  it("blames a C-account payer for a SAC resource overrun, at the usual count", async () => {
    const { policy, store, metrics } = setup();
    const wallet = contract();
    const overrun: FailureCause = { opCode: "invokeHostFunctionResourceLimitExceeded" };
    const fail = () =>
      policy.onFinal(
        finalRecord(context({ payer: wallet }), "failed", { failure: overrun }),
        "settle",
      );

    await fail();
    await fail();
    expect(await store.breakerOpenUntil(`payer:${wallet}`, 1_000_000)).toBeUndefined();
    await fail();
    expect(await store.breakerOpenUntil(`payer:${wallet}`, 1_000_000)).toBe(1_000_000 + HOUR);
    // A G-account's is ours: an event only.
    await policy.onFinal(finalRecord(context(), "failed", { failure: overrun }), "settle");
    expect(metrics.value("spend_failure_attributed_total", { fault: "ours" })).toBe(1);
  });

  it("never opens a SAC asset breaker, whatever fails", async () => {
    const sac = contract();
    const spy = spyingStore(db.stores().spend);
    const { policy, store } = setup({ store: spy.store });
    const failures: (FailureCause | undefined)[] = [
      undefined,
      {},
      balanceError(sac),
      { error: { type: "sceContract", code: "7" }, contract: sac },
      {
        opCode: "invokeHostFunctionTrapped",
        error: { type: "sceWasmVm", code: "scecInvalidAction" },
      },
      { opCode: "invokeHostFunctionResourceLimitExceeded" },
    ];

    for (let round = 0; round < 3; round++)
      for (const failure of failures) {
        const ctx = context({ asset: sac });
        await policy.onFinal(finalRecord(ctx, "failed", { failure }), "settle");
        await policy.onFinal(finalRecord(context({ asset: sac }), "success"), "settle");
      }

    expect(spy.writes.filter((w) => w.includes("asset:"))).toEqual([]);
    expect(await store.breakerOpenUntil(`asset:${sac}`, 1_000_000)).toBeUndefined();
  });

  it("doesn't open the asset breaker when the kind is unconfirmed: an RPC blip must not trip a SAC (0024)", async () => {
    const asset = contract();
    const spy = spyingStore(db.stores().spend);
    // kind() defaults to wasm, but the read never confirmed it — it may be a SAC.
    const { policy, store, metrics } = setup({
      store: spy.store,
      assets: fakeAssets({ [asset]: "wasm" }, [asset]),
    });
    // Each from a fresh payer, so only the asset's breaker could open.
    for (let i = 0; i < BREAKERS.wasmAsset.failures + 1; i++)
      await policy.onFinal(
        finalRecord(context({ asset }), "failed", {
          failure: { error: { type: "sceContract", code: "3" }, contract: asset },
        }),
        "settle",
      );
    expect(spy.writes.filter((w) => w.includes("asset:"))).toEqual([]);
    expect(await store.breakerOpenUntil(`asset:${asset}`, 1_000_000)).toBeUndefined();
    expect(metrics.value("spend_breaker_opened_total", { breaker: "asset" })).toBe(0);
  });

  it("opens a wasm asset breaker only when failures reach successes", async () => {
    const wasm = contract();
    const fresh = contract();
    const spy = spyingStore(db.stores().spend);
    const { policy, store, metrics, events } = setup({
      store: spy.store,
      assets: fakeAssets({ [wasm]: "wasm", [fresh]: "wasm" }),
    });
    // Each from another payer, so only the asset's breaker can open.
    const fail = (asset: string) =>
      policy.onFinal(
        finalRecord(context({ asset }), "failed", {
          failure: { error: { type: "sceContract", code: "3" }, contract: asset },
        }),
        "settle",
      );
    const open = (asset: string) => store.breakerOpenUntil(`asset:${asset}`, 1_000_000);

    for (let i = 0; i < 6; i++)
      await policy.onFinal(finalRecord(context({ asset: wasm }), "success"), "settle");
    expect(spy.writes.filter((w) => w === `success asset:${wasm}`)).toHaveLength(6);
    for (let i = 0; i < 5; i++) await fail(wasm);
    expect(await open(wasm)).toBeUndefined();
    await fail(wasm);
    expect(await open(wasm)).toBe(1_000_000 + 600_000);

    // With no successes, five failures are enough and four are not.
    for (let i = 0; i < 4; i++) await fail(fresh);
    expect(await open(fresh)).toBeUndefined();
    await fail(fresh);
    expect(await open(fresh)).toBe(1_000_000 + 600_000);

    expect(metrics.value("spend_breaker_opened_total", { breaker: "asset" })).toBe(2);
    expect(metrics.value("spend_failure_attributed_total", { fault: "asset" })).toBe(11);
    expect(metrics.value("spend_failure_attributed_total", { fault: "payer" })).toBe(11);
    expect(events("spend_breaker_opened").map((e) => e.scope)).toEqual([
      `asset:${wasm}`,
      `asset:${fresh}`,
    ]);
    expect(BREAKERS.wasmAsset.failures).toBe(5);
  });

  it("reopens for longer on the next failure after it closed", async () => {
    const { policy, store, events, clock } = setup();
    const payer = account();
    const scope = `payer:${payer}` as const;
    const fail = () =>
      policy.onFinal(
        finalRecord(context({ payer }), "failed", { failure: balanceError(USDC) }),
        "settle",
      );

    for (let i = 0; i < 3; i++) await fail();
    const first = clock.now + HOUR;
    expect(await store.breakerOpenUntil(scope, clock.now)).toBe(first);
    // A failure that was in flight while it is open neither extends it nor reports an opening.
    clock.now += 60_000;
    await fail();
    expect(await store.breakerOpenUntil(scope, clock.now)).toBe(first);
    expect(events("spend_breaker_opened")).toHaveLength(1);

    clock.now = first;
    await fail();
    expect(await store.breakerOpenUntil(scope, clock.now)).toBe(clock.now + 4 * HOUR);
    clock.now += 4 * HOUR;
    await fail();
    const third = clock.now;
    expect(await store.breakerOpenUntil(scope, clock.now)).toBe(third + 16 * HOUR);

    // A day without an opening clears the strikes: three failures again, for the first step.
    clock.now = third + 24 * HOUR + 1;
    await fail();
    await fail();
    expect(await store.breakerOpenUntil(scope, clock.now)).toBeUndefined();
    await fail();
    expect(await store.breakerOpenUntil(scope, clock.now)).toBe(clock.now + HOUR);
    expect(events("spend_breaker_opened")).toHaveLength(4);
  });

  it("counts ours failures in no breaker", async () => {
    const spy = spyingStore(db.stores().spend);
    const { policy, metrics, events } = setup({ store: spy.store });
    const failure: FailureCause = { opCode: "invokeHostFunctionEntryArchived" };
    const ctx = context();

    for (let i = 0; i < 5; i++)
      await policy.onFinal(finalRecord(ctx, "failed", { failure }), "settle");

    expect(spy.writes).toEqual([]);
    expect(metrics.value("spend_failure_attributed_total", { fault: "ours" })).toBe(5);
    expect(events("spend_failure_ours")).toHaveLength(5);
    expect(events("spend_failure_ours")[0]).toEqual(
      expect.objectContaining({ key: ctx.key, failure }),
    );
  });

  it("commits before feeding the breakers, so a breaker error can't skip it", async () => {
    const real = db.stores().spend;
    const { policy } = setup({
      store: overriding(real, {
        recordFailure: async () => {
          throw new Error("down");
        },
      }),
    });
    const ctx = context();
    expect(await policy.beforeSubmit(ctx)).toEqual({ allow: true });

    await expect(
      policy.onFinal(finalRecord(ctx, "failed", { failure: balanceError(USDC) }), "settle"),
    ).rejects.toThrow("down");
    expect(await used(real, "global")).toBe(14_278n);
  });
});

describe("verifyWithBreakers", () => {
  const requirements = (payTo: string) =>
    ({ payTo, asset: USDC }) as unknown as PaymentRequirements;

  it("refuses an accepted payment on an open breaker, with its payer and no address in the message", async () => {
    const payer = account();
    const payTo = account();
    const breakerRefusal = vi.fn(async () => SETTLE_REASONS.breakerOpenPayTo);
    const verify = verifyWithBreakers(async () => ({ isValid: true, payer }), {
      policy: { breakerRefusal },
      logger: jsonLogger("error", () => {}),
      metrics: memoryMetrics(),
      now: () => 42,
    });
    const response = await verify({} as PaymentPayload, requirements(payTo));
    expect(response).toMatchObject({
      isValid: false,
      invalidReason: SETTLE_REASONS.breakerOpenPayTo,
      payer,
    });
    expect(response.invalidMessage).not.toContain(payTo);
    expect(breakerRefusal).toHaveBeenCalledWith({ payer, payTo, asset: USDC }, 42);
  });

  it("answers a refusal as it is, without reading a breaker", async () => {
    const breakerRefusal = vi.fn(async () => SETTLE_REASONS.breakerOpenPayer);
    const refusal = { isValid: false, invalidReason: "invalid_network", payer: account() };
    const verify = verifyWithBreakers(async () => refusal, {
      policy: { breakerRefusal },
      logger: jsonLogger("error", () => {}),
      metrics: memoryMetrics(),
    });
    expect(await verify({} as PaymentPayload, requirements(account()))).toBe(refusal);
    expect(breakerRefusal).not.toHaveBeenCalled();
  });

  it("answers upstream's verdict when the breakers can't be read, and counts it", async () => {
    const accepted = { isValid: true, payer: account() };
    const metrics = memoryMetrics();
    const lines: string[] = [];
    const verify = verifyWithBreakers(async () => accepted, {
      policy: { breakerRefusal: async () => Promise.reject(new Error("store down")) },
      logger: jsonLogger("debug", (line) => lines.push(line)),
      metrics,
    });
    expect(await verify({} as PaymentPayload, requirements(account()))).toBe(accepted);
    expect(metrics.value("spend_store_failures_total", { op: "breaker" })).toBe(1);
    expect(lines.join("")).toContain('"spend_store_failed"');
  });
});
