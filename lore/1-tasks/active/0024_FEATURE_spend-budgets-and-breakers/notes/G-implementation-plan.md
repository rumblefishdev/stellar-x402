---
title: "0024 implementation plan"
type: generation
status: developing
spawns: []
history:
  - date: "2026-10-30"
    status: developing
    who: akot
    note: "Plan from the accepted S-design; five PRs in risk order."
tags: [facilitator, fees, budgets, breakers, plan]
---

# 0024 Spend Budgets and Breakers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the facilitator's fee loss with a proven payer, single-flight per (payer, asset),
tiered rolling budgets, exact accounting and attributed breakers, as [S-design](S-design.md)
decides.

**Architecture:** Five PRs in risk order on branch `lore-0024-spend-budgets-and-breakers`, each
mergeable alone: (1) payer proof and zero amount, (2) `SpendStore` changes, (3) failure cause from
the pool to the record, (4) single-flight in `claim`, (5) the `SpendPolicy` that uses all of them,
wired into the existing `beforeSubmit`/`onFinal` hooks, plus config, reasons, docs and the pubnet
rule. Policy code lives in a new `apps/facilitator/src/spend/` directory.

**Tech Stack:** TypeScript (ESM), vitest, PostgreSQL 18 (tests: compose's `127.0.0.1:15432` or
`TEST_DATABASE_URL`), `@stellar/stellar-sdk` 16.3.0, `@x402/stellar` 2.28.0, Soroban (Rust 1.97.1,
soroban-sdk 28) for one testnet fixture.

**Spec:** [S-design](S-design.md). Research: [R-codebase-map](R-codebase-map.md),
[R-breakers](R-breakers.md), [R-budgets-and-edges](R-budgets-and-edges.md),
[R-wasm-auth](R-wasm-auth.md), [R-spike-payer-proof](R-spike-payer-proof.md).

## Global Constraints

- Every budget counts the facilitator's fees in stroops (int64), in one rolling window
  `SPEND_WINDOW_MS` (default 86,400,000).
- Defaults: global 500,000,000; per payer 20,000,000; per payTo 100,000,000; per known asset
  250,000,000; per other-tier asset 20,000,000; `tier:other` 100,000,000; balance floor
  50,000,000 (250,000,000 until 0027 decision 7).
- Reserve at `maxFeeStroops` (the ceiling); commit `feeCharged`; release otherwise.
- Fail closed: a store, balance or asset-kind failure never lets a payment through unreserved.
- Known tier = the network's USDC SAC (`getUsdcAddress(network)` from `@x402/stellar`); every
  other asset is `other`. Kind (`sac | wasm`) is separate and only feeds attribution.
- Metric labels from closed sets only; addresses only in log lines.
- No token allowlist: every SEP-41 token still settles (ADR 0007).
- Migrations are transactional, expand-only, and lock `reserve`'s tables in the order
  `spend_reservations`, `spend_scopes`, `spend_reservation_scopes` (postgres-schema.ts header).
- Reasons are the closed set in S-design §10; never addresses, amounts or reset times in them.
- Commit messages: `feat|fix|docs|test(lore-0024): …`, no Claude co-author line.

## Review Focus

1. **Lease hand-over or a crash leaves an in-flight row** whose settlement is final or missing:
   the next claim for that (payer, asset) must succeed, not answer `busy` forever. Test in Task 6.
2. **An RPC without diagnostic events** (common on third-party mainnet RPCs): attribution falls
   back to payer (+ asset if wasm) and never blames `payTo`. Test in Task 8.
3. **A reserve that arrives after its release** (late hook across instances): counts nothing.
   Test in Task 3.
4. **The store under the flood the budgets exist for** (`55P03`, lost COMMIT): retried with the
   same id inside the deadline, then `spend_store_unavailable`, and no reservation left counted.
   Test in Task 9.
5. **A C-account payer** (`__check_auth`) passes the payer proof: its nonce key is written under
   the contract's address. Unit test in Task 2, testnet run in Task 12.

---

## PR 1: payer proof and zero amount

### Task 1: Refuse a zero amount

**Files:**
- Modify: `apps/facilitator/src/settlement/verify.ts` (constant near line 49; check at the top of
  `createChecker`'s returned function, after the network check, before upstream verify)
- Test: `apps/facilitator/test/verify.test.ts`

**Interfaces:**
- Produces: `export const AMOUNT_ZERO_REASON = "invalid_exact_stellar_payload_amount_zero"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses a zero amount before calling upstream", async () => {
  for (const amount of ["0", "000"]) {
    const { response } = await check(payload, { ...requirements, amount });
    expect(response).toMatchObject({ isValid: false, invalidReason: AMOUNT_ZERO_REASON });
  }
  expect(upstream.verify).not.toHaveBeenCalled();
});
it("passes amount 1 through to upstream", async () => { /* upstream called once */ });
```

- [ ] **Step 2:** `pnpm --filter @stellar-x402/facilitator exec vitest run test/verify.test.ts`
  → FAIL (`AMOUNT_ZERO_REASON` undefined).
- [ ] **Step 3:** Add the constant and the check: `/^0+$/.test(requirements.amount)` →
  `invalid(AMOUNT_ZERO_REASON, undefined, "the payment amount is 0")`. `/settle` gets it through
  `settleCheck`, which uses the same checker.
- [ ] **Step 4:** Same command → PASS; then the whole facilitator suite.
- [ ] **Step 5:** Commit `feat(lore-0024): refuse a zero-amount payment`.

### Task 2: Require the payer's nonce in the settlement's footprint

**Files:**
- Modify: `apps/facilitator/src/settlement/settle.ts` (`SETTLE_REASONS`, `expectTransfer` ~916,
  its call ~423, `reasonFor` ~857)
- Test: `apps/facilitator/test/payer-proof.test.ts` (new), `apps/facilitator/test/settle.test.ts`

**Interfaces:**
- Produces:
  - `SETTLE_REASONS.payerNotAuthorized = "settle_exact_stellar_payer_not_authorized"`
  - `export class PayerNotAuthorizedError extends Error`
  - `export function hasPayerNonce(sim: rpc.Api.SimulateTransactionSuccessResponse, payer: string, nonce: string): boolean`
    — true iff `sim.transactionData.build().resources().footprint().readWrite()` holds a
    `contractData` key with `contract == Address(payer)`, `key` = `scvLedgerKeyNonce` with that
    nonce, `durability` temporary.
  - `expectTransfer(expected: { asset; from; to; amount; nonce: string })`: after the event checks,
    throws `PayerNotAuthorizedError` when `!hasPayerNonce(sim, from, nonce)`.

- [ ] **Step 1: Write the failing tests** in `payer-proof.test.ts`, building a
  `SimulateTransactionSuccessResponse` with one valid transfer event and a `SorobanDataBuilder`
  footprint:

```ts
it("accepts the payer's nonce key in the read-write footprint");          // G payer
it("accepts a C-account payer's nonce key");                              // Review Focus 5
it("refuses a footprint without it (a token that skips require_auth)", () =>
  expect(() => check(simWithout)).toThrow(PayerNotAuthorizedError));
it("refuses the key only in the read-only footprint");
it("refuses another address's nonce key, and the payer's key with another nonce");
```

  and in `settle.test.ts`: `reasonFor(new SimulationCheckError("x", { cause: new PayerNotAuthorizedError("y") }))`
  `=== SETTLE_REASONS.payerNotAuthorized`, while a plain `SimulationCheckError` stays
  `balanceChanges`.
- [ ] **Step 2:** `pnpm --filter @stellar-x402/facilitator exec vitest run test/payer-proof.test.ts test/settle.test.ts` → FAIL.
- [ ] **Step 3:** Implement as in Interfaces; the call site passes `nonce: verified.nonce`;
  `reasonFor` checks `error.cause instanceof PayerNotAuthorizedError` before the
  `SimulationCheckError` line. Add the reason to the README's `/settle` table ("the payment's
  auth was never used by the token: its `transfer` doesn't require the payer's signature — sign
  a new payment in another asset").
- [ ] **Step 4:** Same command → PASS; full suite; `pnpm lint`; `pnpm -r exec tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(lore-0024): refuse a settlement whose payer auth was never used`.

---

## PR 2: SpendStore

### Task 3: Released tombstone and usage from `reserve`

**Files:**
- Modify: `apps/facilitator/src/ports/spend-store.ts`, `apps/facilitator/src/adapters/postgres.ts`
  (~533-668), `apps/facilitator/src/adapters/postgres-schema.ts` (new migration
  `0006_spend_budgets`)
- Test: `apps/facilitator/test/port-contracts.ts` (`spendStoreContract`),
  `apps/facilitator/test/postgres.test.ts`, `apps/facilitator/test/migrate.test.ts`

**Interfaces:**
- Produces (port):
  - `SpendScope` gains `"tier:other"`; a per-asset payer scope is `` `payer:${addr}/${asset}` ``.
  - `interface ScopeUsage { scope: SpendScope; usedStroops: bigint; maxStroops: bigint }` (used
    includes this reservation).
  - `ReserveResult = { reserved: true; usage: ScopeUsage[] } | { reserved: false; scope: SpendScope } | { reserved: false; released: true }`;
    a repeated reserved/committed id answers `{ reserved: true, usage: [] }`.
  - `release(id: string, now: number): Promise<void>`: a `reserved` row becomes `released` and
    loses its scope rows; a missing id gets a `released` row stamped `now`; a `committed` row is
    untouched.
  - `commit` on a `released` row resolves `false`.
- Migration `0006_spend_budgets` (transactional, in reserve's lock order): replace
  `spend_reservations`' state CHECK with `('reserved','committed','released')`; add to
  `spend_scopes` `window_start bigint`, `successes integer NOT NULL DEFAULT 0`,
  `strikes integer NOT NULL DEFAULT 0`, `last_opened_at bigint` (used by Task 4).

- [ ] **Step 1: Write the failing contract tests**

```ts
it("refuses a reserve after its release and counts nothing");       // Review Focus 3
it("tombstones a release of an unknown id, so a later reserve is refused");
it("keeps a committed reservation on release");
it("resolves commit false on a released id");
it("returns each limit's window sum, this reservation included");
it("returns no usage for a repeated id");
it("prunes released rows like the others");
```

- [ ] **Step 2:** `pnpm --filter @stellar-x402/facilitator exec vitest run test/postgres.test.ts test/migrate.test.ts` → FAIL.
- [ ] **Step 3:** Implement: `reserve` reads the conflicting row's state (`released` →
  `{reserved:false, released:true}`) and returns the per-limit sums it already computes;
  `release` is one `INSERT … ON CONFLICT (id) DO UPDATE SET state='released' WHERE state='reserved'`
  plus the scope-row delete. Update every `release` caller to pass `now`.
- [ ] **Step 4:** Same command → PASS; full suite.
- [ ] **Step 5:** Commit `feat(lore-0024): keep a released reservation and return window sums`.

### Task 4: Windowed breaker counters with strikes

**Files:** as Task 3 (port, adapter); tests in `port-contracts.ts`.

**Interfaces:**
- Produces (port, replacing `recordFailure`/`recordSuccess`/`openBreaker`):
  - `recordFailure(scope, now, windowMs): Promise<{ failures: number; successes: number; strikes: number }>`
    — counts in a window that starts at the first event and restarts once `now - window_start > windowMs`
    (failures and successes reset together); `strikes` as stored.
  - `recordSuccess(scope, now, windowMs): Promise<void>` — counts, never resets failures.
  - `interface BreakerBackoff { baseMs: number; factor: number; maxMs: number; strikeResetMs: number }`
  - `openBreaker(scope, now, backoff): Promise<number>` — one statement: if `breaker_until > now`
    return it unchanged; else strikes := (last_opened_at < now - strikeResetMs ? 0 : strikes),
    until := now + min(baseMs × factor^strikes, maxMs), strikes + 1, last_opened_at := now;
    returns `until`. Later end still wins across instances.
  - `breakerOpenUntil` unchanged.

- [ ] **Step 1: Failing contract tests**

```ts
it("counts failures within the window and restarts after it");       // uses now, unlike today
it("counts successes without resetting failures");
it("opens for baseMs first, then base×factor, capped at maxMs");
it("adds one strike when two instances open it together");
it("clears strikes after strikeResetMs without an opening");
```

- [ ] **Step 2:** run as Task 3 → FAIL. **Step 3:** implement with `INSERT … ON CONFLICT … RETURNING`.
- [ ] **Step 4:** PASS; full suite. **Step 5:** Commit `feat(lore-0024): count breaker failures in a window, back off on reopening`.

---

## PR 3: failure cause

### Task 5: Decode and keep why an included transaction failed

**Files:**
- Create: `packages/signer-pool/src/failure-cause.ts`; export from `packages/signer-pool/src/index.ts`
- Modify: `packages/signer-pool/src/types.ts` (`SubmitResult`), `packages/signer-pool/src/submitter.ts`
  (~856-866), `packages/signer-pool/src/testing.ts` (`FakeRpc`),
  `apps/facilitator/src/ports/settlement-store.ts`, `apps/facilitator/src/adapters/postgres.ts`
  (`UPDATE_COLUMNS`, `toRecord`), `apps/facilitator/src/adapters/postgres-schema.ts`
  (migration `0007_settlement_failure`: `ALTER TABLE settlements ADD COLUMN failure jsonb;`),
  `apps/facilitator/src/settlement/settle.ts` (failed finish), `apps/facilitator/src/settlement/reconcile.ts` (`land`)
- Test: `packages/signer-pool/test/failure-cause.test.ts`, `packages/signer-pool/test/submitter.test.ts`,
  `apps/facilitator/test/reconcile.test.ts`, `port-contracts.ts`

**Interfaces:**
- Produces:
  - `export interface FailureCause { opCode?: string; error?: { type: string; code: string }; contract?: string; data?: string[] }`
    — `opCode` the first operation's `InvokeHostFunctionResult` switch name; from the first
    diagnostic event whose topic 0 is the symbol `error`: `error` (the `ScError` type name and
    its code, e.g. `{ type: "sceContract", code: "10" }`), `contract` (the event's contract
    address), `data` (address strings found in the event data, for Task 8's `from`/`to` test).
  - `export function failureCause(res: rpc.Api.GetFailedTransactionResponse): FailureCause`
  - `SubmitResult.failure?: FailureCause` (set only with `status: "failed"`).
  - `SettlementRecord.failure?: FailureCause`; `SettlementUpdate` may set it.
  - `FakeRpc` option `failure: { opCode; diagnosticEvents?: xdr.DiagnosticEvent[] }` used with
    `failOnChain`.

- [ ] **Step 1: Failing tests:** `failureCause` on fixtures: trapped with a SAC
  `Error(Contract, #10)` event → `{ opCode: "invokeHostFunctionTrapped", error: {type:"sceContract",code:"10"}, contract: <SAC> }`;
  `resourceLimitExceeded` with no events → `{ opCode }` only; a fee-bump inner failure is read
  through the inner result. Submitter: a failed result carries `failure`. Store: `failure`
  round-trips and is absent when not set. Reconcile: a failed `land` stores `failure`.
- [ ] **Step 2:** `pnpm --filter @stellar-x402/signer-pool test` and the facilitator files → FAIL.
- [ ] **Step 3:** Implement; never throw from `failureCause` (a decode error yields `{}`).
- [ ] **Step 4:** PASS; both packages' suites; `pnpm lint`.
- [ ] **Step 5:** Commit `feat(lore-0024): record why an included settlement failed`.

---

## PR 4: single-flight

### Task 6: One non-final settlement per (network, payer, asset)

**Files:**
- Modify: `apps/facilitator/src/ports/settlement-store.ts` (`ClaimResult`),
  `apps/facilitator/src/adapters/postgres.ts` (`claim` ~244, `moveState` ~392),
  `apps/facilitator/src/adapters/postgres-schema.ts` (migration `0008_settlement_in_flight`),
  `apps/facilitator/src/settlement/settle.ts` (claim branch, `SETTLE_REASONS`)
- Test: `port-contracts.ts`, `apps/facilitator/test/settle.test.ts`, `settle-pool.test.ts`

**Interfaces:**
- Produces:
  - Migration: `CREATE TABLE settlement_in_flight (network text NOT NULL, payer text NOT NULL, asset text NOT NULL, key text NOT NULL, PRIMARY KEY (network, payer, asset));`
  - `ClaimResult` gains `| { claimed: false; busy: SettlementKey }` (the blocker's key).
  - `claim`, in one transaction: an existing record with the same key → `existing` (as today);
    else take the in-flight row for (network, payer, `paymentRequirements.asset`), replacing it
    only when its key's settlement is final or missing; not taken → `busy`; taken → insert the
    settlement.
  - Every move to a final state deletes the row whose `key` is the settlement's, in the same
    transaction.
  - `SETTLE_REASONS.payerBusy = "settle_exact_stellar_payer_busy"`.
  - `settle()` on `busy`: poll `store.get(blocker)` every `pollMs` (the existing option, 250) until
    it is final, then claim again; past `left()` answer `failure(SETTLE_REASONS.payerBusy, payer)`
    with no record written and count it in `settlement_outcomes_total`.

- [ ] **Step 1: Failing tests**

```ts
// port-contracts.ts
it("answers busy with the blocker's key for a second key of one payer and asset");
it("claims for another asset, another payer or another network");
it("still answers existing for a repeat of the same key");
it("frees the slot when the blocker turns final");
it("takes over a row whose settlement is final or missing");          // Review Focus 1
// settle.test.ts
it("waits for the blocker and settles once it is final");
it("answers payer_busy past the budget and writes no record");
// settle-pool.test.ts
it("settles a burst from one balance one at a time and fails none on chain");
```

- [ ] **Step 2:** run the three files → FAIL. **Step 3:** implement as in Interfaces.
- [ ] **Step 4:** PASS; full suite. README `/settle` table: `payer_busy` — "another payment from
  this payer in this asset is settling; send the same payment again".
- [ ] **Step 5:** Commit `feat(lore-0024): settle one payment per payer and asset at a time`.

---

## PR 5: spend policy, config and docs

### Task 7: Asset kind and tier

**Files:** Create `apps/facilitator/src/spend/asset-kinds.ts`; test `apps/facilitator/test/asset-kinds.test.ts`.

**Interfaces:**
- Produces:
  - `export type AssetKind = "sac" | "wasm"; export type AssetTier = "known" | "other";`
  - `export interface AssetKinds { kind(asset: string): Promise<AssetKind>; tier(asset: string): AssetTier }`
  - `export function createAssetKinds(deps: { rpc: Pick<SorobanRpc, "getLedgerEntries">; known: readonly string[] }): AssetKinds`
    — `kind`: a known asset is `sac` with no RPC; otherwise one `getLedgerEntries` of the
    contract's instance key, `sac` iff its executable is `contractExecutableStellarAsset`, cached
    for good; an RPC error or a missing entry answers `wasm` and is not cached. `tier`: `known`
    iff in `known`.

- [ ] **Step 1: Failing tests:** known USDC → `sac`, zero RPC calls; a SAC instance → `sac`;
  a wasm instance → `wasm`; second call served from cache; an RPC rejection → `wasm`, and the
  next call asks again; a self-issued SAC → kind `sac`, tier `other`.
- [ ] **Steps 2-5:** run (`vitest run test/asset-kinds.test.ts`) → FAIL; implement; PASS; commit
  `feat(lore-0024): tell SAC from wasm and known from other assets`.

### Task 8: Failure attribution

**Files:** Create `apps/facilitator/src/spend/attribution.ts`; test `apps/facilitator/test/attribution.test.ts`.

**Interfaces:**
- Consumes: `FailureCause` (Task 5), `AssetKind` (Task 7).
- Produces: `export type Fault = "payer" | "payTo" | "asset" | "ours";`
  `export function attribute(failure: FailureCause | undefined, ctx: { kind: AssetKind; payer: string; payTo: string; asset: string }): Fault[]`.
  Rules (S-design §7), first match wins:
  1. `error.type` is auth, or `contract === payer` → `["payer"]`
  2. SAC (`contract === asset`, kind `sac`) contract error 5, 9 or 10 → `["payer"]`
  3. SAC error 11 or 13 → `["payTo"]` if `data` names `payTo`, else `["payer"]`
  4. kind `wasm` and (`contract === asset` or opCode resource-limit / insufficient-refundable-fee) → `["asset", "payer"]`
  5. kind `sac` and opCode resource-limit / insufficient-refundable-fee / entry-archived → `["ours"]`
  6. otherwise → `["payer"]`, plus `"asset"` if kind `wasm`; never `"payTo"`

- [ ] **Step 1:** one `it.each` row per rule and per Review Focus 2 (`failure` undefined, SAC →
  `["payer"]`; wasm → `["payer","asset"]` in any order).
- [ ] **Steps 2-5:** FAIL → implement → PASS → commit `feat(lore-0024): attribute an on-chain failure to whoever caused it`.

### Task 9: SpendPolicy before submit

**Files:**
- Create: `apps/facilitator/src/spend/policy.ts`, `apps/facilitator/src/spend/limits.ts`
- Modify: `apps/facilitator/src/settlement/hooks.ts` (`BeforeSubmitContext.deadline: number`),
  `apps/facilitator/src/settlement/settle.ts` (passes `deadline: startedAt + deps.budgetMs`; new
  reasons)
- Test: `apps/facilitator/test/spend-policy.test.ts` (PostgreSQL store, fake `AssetKinds`,
  fake `BalanceFloor`, `memoryMetrics`, `jsonLogger`)

**Interfaces:**
- Consumes: Tasks 3, 4, 7.
- Produces:
  - `limits.ts`: `export interface SpendBudgets { windowMs; globalStroops; perPayerStroops; perPayToStroops; perKnownAssetStroops; perOtherAssetStroops; tierOtherStroops }`
    and `export function spendLimits(ctx: { payer; payTo; asset }, tier: AssetTier, budgets: SpendBudgets): SpendLimit[]`
    in the order payer (`payer:<p>` or `payer:<p>/<asset>` for `other`), `payTo:<t>`, `asset:<a>`,
    `tier:other` (only for `other`), `global`.
  - `export function budgetKind(scope: SpendScope): "payer" | "pay_to" | "asset" | "other" | "global"`.
  - `SETTLE_REASONS` gains `spendLimit(kind)` names `settle_exact_stellar_spend_limit_{payer,pay_to,asset,other,global}`,
    `breakerOpen{Payer,PayTo,Asset}` = `settle_exact_stellar_breaker_open_{payer,pay_to,asset}`,
    `spendStoreUnavailable`, `facilitatorUnderfunded` (S-design §10).
  - `export interface BalanceFloor { below(): boolean }` (implemented in Task 11).
  - `export function createSpendPolicy(deps: { store: SpendStore; assets: AssetKinds; floor: BalanceFloor; budgets: SpendBudgets; logger: Logger; metrics: Metrics; sleep?: (ms: number) => Promise<void> }): SpendPolicy`
  - `export interface SpendPolicy { beforeSubmit: SettlementHooks["beforeSubmit"]; onFinal: SettlementHooks["onFinal"]; breakerRefusal(ctx: { payer; payTo; asset }, now: number): Promise<string | undefined> }`
  - `beforeSubmit` order: floor → `breakerRefusal` → tier → `reserve(key, maxFeeStroops, limits)`
    retried with the same id every 200 ms until `deadline` on rejection → on `{reserved:true}` emit
    nearing events and allow; on `{scope}` refuse `spend_limit_<budgetKind>`; on `released`
    refuse `settle_exact_stellar_refused`; on final rejection release best-effort and refuse
    `spend_store_unavailable`, counting `spend_store_failures_total{op:"reserve"}`.
  - Nearing: emit `spend_budget_nearing` (log: scope, used, max, windowMs) and
    `spend_budget_nearing_total{budget}` when `usedStroops >= 0.8 × maxStroops` and that scope
    hasn't emitted in the last 15 min (in-process `Map`, capped at 10,000 entries).

- [ ] **Step 1: Failing tests**

```ts
it("reserves the ceiling against payer, payTo, asset and global for USDC");
it("adds tier:other and keys the payer by asset for another token");
it("refuses with the narrowest budget's reason and submits nothing");
it("refuses below the balance floor before reserving");
it("refuses an open payer, payTo or wasm-asset breaker before reserving");
it("retries a rejected reserve with the same id and allows once it lands"); // Review Focus 4
it("refuses spend_store_unavailable past the deadline and leaves nothing counted");
it("emits spend_budget_nearing once per scope at 80 %");
```

- [ ] **Steps 2-5:** FAIL → implement → PASS (+ full suite) → commit `feat(lore-0024): reserve fees against tiered budgets before submit`.

### Task 10: SpendPolicy on final

**Files:** Modify `apps/facilitator/src/spend/policy.ts`; test `apps/facilitator/test/spend-policy.test.ts`.

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 7, 8.
- Produces: `export const BREAKERS` (S-design §7), as data:

```ts
export const BREAKERS = {
  payer: { failures: 3, authFailures: 1, windowMs: 3_600_000, backoff: { baseMs: 3_600_000, factor: 4, maxMs: 86_400_000, strikeResetMs: 86_400_000 } },
  payTo: { failures: 3, windowMs: 3_600_000, backoff: { baseMs: 3_600_000, factor: 4, maxMs: 86_400_000, strikeResetMs: 86_400_000 } },
  wasmAsset: { failures: 5, windowMs: 600_000, backoff: { baseMs: 600_000, factor: 2, maxMs: 21_600_000, strikeResetMs: 86_400_000 } },
} as const;
```

  `onFinal(record)`: `feeCharged` set → `commit(key, feeCharged)` (false → error log
  `spend_commit_unmatched` + `spend_commit_unmatched_total{state}`), else `release(key, now)`.
  Then only for `failed` with a fee: `attribute(...)`; per fault: `ours` → log
  `spend_failure_ours` only; else `recordFailure(scope, now, windowMs)` and `openBreaker` when
  failures ≥ threshold (1 for an auth error in a C-account payer's frame), or when strikes > 0
  and the breaker is closed (reopen at the next step); the wasm asset also needs
  failures ≥ successes. Each opening logs `spend_breaker_opened` (scope, until) and counts
  `spend_breaker_opened_total{breaker}`. On `success`: `recordSuccess` for a wasm asset's scope.
  Every attributed fault counts `spend_failure_attributed_total{fault}`.

- [ ] **Step 1: Failing tests**

```ts
it("commits the fee charged for success and failed, releases otherwise");
it("logs and counts a commit that matched no reservation");
it("opens the payer breaker on the third attributed failure in an hour");
it("opens it on the first auth failure of a C-account payer");
it("never opens a SAC asset breaker, whatever fails");
it("opens a wasm asset breaker only when failures reach successes");
it("reopens for longer on the next failure after it closed");
it("counts ours failures in no breaker");
```

- [ ] **Steps 2-5:** FAIL → implement → PASS → commit `feat(lore-0024): settle reservations and feed attributed breakers on final`.

### Task 11: Balance floor, wiring, config, reasons and docs

**Files:**
- Create: `apps/facilitator/src/spend/balance-floor.ts`
- Modify: `apps/facilitator/src/config.ts`, `apps/facilitator/src/main.ts` (`compose` hooks
  ~493-499, `/verify` wiring, pruner unchanged), `apps/facilitator/README.md`,
  `deploy/*.env.example`, `docs/adr/0007-fee-abuse-containment.md`,
  `docs/architecture/m1-spine.md` (AD-18), `docs/threat-model.md`,
  `lore/1-tasks/backlog/0060_FEATURE_api-key-limiter.md`,
  `lore/1-tasks/active/0071_*` (its pubnet sentence), this task's README
- Test: `apps/facilitator/test/balance-floor.test.ts`, `config.test.ts`, `main.test.ts`,
  `verify-route.test.ts`, `settle-route.test.ts`

**Interfaces:**
- Produces:
  - `export function createBalanceFloor(deps: { rpc: Pick<SorobanRpc,"getLedgerEntries">; account: string; floorStroops: bigint; intervalMs: number; logger; metrics }): BalanceFloor & { start(): void; stop(): void }`
    — reads the account entry's balance every `intervalMs` (default 30,000); `below()` is true
    with no reading yet or under the floor; a failed read keeps the last value; logs
    `facilitator_underfunded` on crossing down and `facilitator_funded` on crossing up.
  - Config (`config.spend`): `SPEND_GLOBAL_STROOPS` 500000000, `SPEND_PER_PAYER_STROOPS`
    20000000, `SPEND_PER_PAY_TO_STROOPS` 100000000, `SPEND_PER_ASSET_STROOPS` 250000000 (known),
    `SPEND_PER_ASSET_OTHER_STROOPS` 20000000, `SPEND_TIER_OTHER_STROOPS` 100000000,
    `SPEND_FLOOR_STROOPS` 50000000, `SPEND_BALANCE_INTERVAL_MS` 30000; every stroops value
    ≤ int64 max. `BREAKER_FAILURES` and `BREAKER_COOLDOWN_MS` refused as "no longer read: the
    breaker policy is fixed (S-design §7)", like `STORE`.
  - Pubnet refine message: `"stellar:pubnet is refused until the lease fencing token (0071) and caller authentication with per-key fee budgets (0060) or pricing land"`; the comment says why (S-design §11, residual risk).
  - `compose`: `createAssetKinds({ rpc, known: [getUsdcAddress(config.network)] })`,
    `createBalanceFloor` for the fee-bump account `main()` already derives, `createSpendPolicy`;
    hooks `beforeSubmit`/`onFinal` from it; `/verify` answers
    `invalid(breakerOpen…)` when `policy.breakerRefusal` returns a reason for a payment upstream
    accepted. The floor starts and stops with the app.

- [ ] **Step 1: Failing tests:** floor (no reading → below; above → not; failed read keeps the
  last; crossing logs once); config (defaults, int64 bound, `BREAKER_*` refused, pubnet message
  names 0071 and 0060 and no longer 0024); route tests (a `/settle` over a budget answers
  `success:false` with `settle_exact_stellar_spend_limit_payer` and submits nothing; `/verify`
  with an open payer breaker answers `breaker_open_payer`); `main.test.ts` (hooks wired, floor
  started and stopped).
- [ ] **Step 2:** FAIL. **Step 3:** implement and write the docs:
  - README: config table rows, the reasons of S-design §10 replacing the "a spend reason" row,
    "what a seller sees when a budget refuses", and the Sybil runbook (S-design, residual risk).
  - ADR 0007 amendment (payer proof, tiers, attributed breakers, Sybil-weak per-party budgets,
    shared budgets as an availability lever until callers are authenticated).
  - AD-18 text; threat model entries: parallel spend, `require_auth` skip, breaker abuse, shared
    budget exhaustion by Sybil self-payments.
  - 0060: "a known key may get its own fee budget, apart from the shared ones (0024)".
  - 0071: landing it no longer lifts the pubnet rule.
  - This task's README: tick the AC, record the limits table, add Design Decisions.
- [ ] **Step 4:** PASS; full suite; `pnpm lint`; `pnpm format:check` (or the repo's prettier
  check); `tsc`.
- [ ] **Step 5:** Commit `feat(lore-0024): wire spend budgets, breakers and the balance floor`
  and `docs(lore-0024): …` for the docs.

### Task 12: Testnet evidence

**Files:**
- Create: `contracts/hostile-token/` (testnet-only SEP-41 fixture, copied from `test-token`, with
  `set_mode(u32)`: 0 normal, 1 `transfer` without `require_auth`, 2 `transfer` that panics on odd
  ledgers after `require_auth`); add to the contracts workspace and its README.
- Create: `apps/facilitator/scripts/spend-matrix.ts` (modelled on `scripts/token-matrix.ts`:
  facilitator from `main()`, new channels and seller each run; results to
  `scripts/results/spend-matrix-testnet.json`).

**Interfaces:** none consumed by code; the PR body links the results file.

- [ ] **Step 1:** `pnpm contracts:test` with unit tests for the three modes.
- [ ] **Step 2:** The script runs and records: a USDC and a test-token payment settle; six
  parallel payments from one balance → one settles, the rest `payer_busy` or a free simulation
  refusal, **no failed transaction**; mode 1 → `settle_exact_stellar_payer_not_authorized`, no
  hash; a run with `SPEND_PER_PAYER_STROOPS=300000` → the second payment
  `settle_exact_stellar_spend_limit_payer`; mode 2 → after five failed settlements the asset
  answers `breaker_open_asset`; a C-account payer (a test smart wallet) settles (Review Focus 5).
- [ ] **Step 3:** Commit `test(lore-0024): record the spend matrix on testnet`.

---

## Self-review

- Spec coverage: §1 → T2, T12; §2 → T1; §3 → T6; §4 → T7; §5 → T3, T9, T11; §6 → T3, T9, T10;
  §7 → T4, T5, T8, T10, T11 (`/verify`); §8 → T11; §9 → T9, T10, T11; §10 → T2, T6, T9, T11;
  §11 → T11; residual risk docs → T11; delivery evidence → T12.
- Calls made here (beyond the design): breaker numbers as code constants, not env (`BREAKER_*`
  refused); the breaker window restarts after `windowMs` (tumbling) rather than sliding exactly;
  known tier fixed to the network's USDC; the in-flight row is taken over when its settlement is
  final or missing.
