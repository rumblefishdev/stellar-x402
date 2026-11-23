---
title: "0107 implementation plan"
type: generation
status: mature
spawned_from: notes/S-design.md
spawns: []
tags: [facilitator, fees, budgets, api-keys, portal, hub]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Plan from the approved design; to be carried out in a later session."
---

# Account quota and fee budget (0107) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On pubnet, count every keyed settlement against its account (a monthly quota of payments
and a daily fee budget, by plan), refuse past either, and show the account's use in the hub.

**Architecture:** Two more scopes in 0024's spend store: `account:<owner>` and `free`. `reserve`
gains a count limit beside the stroop sum. An account's plan is a row in the registry; the plans'
figures are config. The portal answers `details.usage` from a SQL view of the account rows.

**Tech Stack:** TypeScript, Express, PostgreSQL, Vitest (stellar-x402); React, Vite
(sorobanscan-api-portal).

**Spec:** [S-design](S-design.md), with the task's [README](../README.md) "Design Decisions". Code
facts: [R-codebase-map](R-codebase-map.md). Read all three before Task 1.

## Global Constraints

- **Where:** worktree `.claude/worktrees/0107`, branch `lore-0107-per-key-fee-quota`. One pull
  request in stellar-x402, rebase-merged, its commits in the order of the tasks below. Push and
  the pull request only when akot says.
- **Commits:** `/lore-framework-git`, `type(lore-0107): …`. No `Co-Authored-By`, no mention of AI,
  no `wip` or `fixup!`. Each commit builds and passes its package's tests.
- **Never move and edit in one commit** (`/risk-split-pr`). Tasks 1 and 2 change no behaviour:
  no existing test assertion changes in them.
- **Tests:** `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`, then
  `corepack pnpm --filter <package> test -- <file>`. The facilitator's tests need PostgreSQL on
  `127.0.0.1:15432`; if the port is closed, ask akot for `sudo docker compose up -d postgres`.
  Rebuild `packages/metrics-catalog` (`corepack pnpm --filter @stellar-x402/metrics-catalog build`)
  after editing it. A `*.test.ts` lives in its package's `test/`; a script against a real network
  goes in `test/live/`.
- **Values, verbatim:**
  - plans `free` 1,000 payments a month and 20,000,000 stroops per 24 h; `basic` 10,000 and
    25,000,000; `pro` 100,000 and 100,000,000;
  - `free` scope 250,000,000 stroops per 24 h; `global` unchanged, 500,000,000;
  - `MAX_FEE_STROOPS` unchanged, 250,000.
- **Reasons, verbatim:** `settle_exact_stellar_quota_exhausted`,
  `settle_exact_stellar_spend_limit_account`, `settle_exact_stellar_spend_limit_free`,
  `invalid_exact_stellar_pay_to_balance_missing`.
- **Messages** name no account, address or XLM amount. The quota's message carries the reset
  instant as RFC 3339 UTC (`2026-12-01T00:00:00Z`).
- **Testnet behaviour doesn't change:** a settlement without a caller reserves exactly today's
  scopes.
- **Migrations** follow the online-migration rules in `postgres-schema.ts`'s header (additive,
  lock order of `reserve`).
- **Docs** are English, in plain language, in the style of the existing ones.

## What can't be checked before 0126, and what stands in

Nothing settles on pubnet until 0126, and the hosted facilitator refuses `NETWORK=stellar:pubnet`.

| Can't be run | Stands in |
|---|---|
| A keyed `/settle` end to end on pubnet | Policy and `settle` tests with a caller passed in (Task 5); the store's contract tests on PostgreSQL (Task 3) |
| The portal reading pubnet's use | The view's test on PostgreSQL and the portal's tests (Tasks 4, 7); on production the card shows 0 until 0126, since the portal reads testnet's database |
| The balance-missing refusal on the hosted testnet (a fresh C balance costs about 120,000 there, under the ceiling) | A local facilitator against testnet with `MAX_FEE_STROOPS=100000`, a script in `apps/facilitator/test/live/` (Task 6) |
| The alarm firing for `free` | The catalog's and infra's unit tests (Task 8); a fire-test after the Alarms deploy is 0126's |

## Review Focus

1. **A settlement stamped in the last millisecond of a month.** Its payment counts in that month
   only, and one stamped at 00:00:00.000 on the 1st counts in the new month (Task 3).
2. **Two reserves for the account's last payment at once.** Exactly one passes (Task 3).
3. **A plan row naming a plan the config no longer has.** The account is treated as `free` and an
   error is logged; `/settle` doesn't throw (Task 5).
4. **A repeat of a payment refused for quota.** It answers the same reason, message and
   `extra.resetsAt` as the first answer (Task 5).
5. **The usage read failing in the portal.** `account` still answers the key, with
   `usage: null` (Task 7).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/facilitator/src/spend/limits.ts` | scope list per traffic kind, budget kinds, reasons | 1, 5 |
| `apps/facilitator/src/spend/period.ts` (new) | the UTC calendar month: start, end | 3 |
| `apps/facilitator/src/ports/spend-store.ts`, `adapters/postgres.ts` | count limit in `reserve` | 3 |
| `apps/facilitator/src/pruner.ts`, `main.ts` | the longest window | 2, 5 |
| `packages/api-keys/src/plans.ts` (new) | plan definitions' parser, `AccountPlanStore`, `AccountUsageReader` | 4 |
| `packages/api-keys/src/postgres.ts`, `test/testing.ts` | their PostgreSQL and in-memory forms, contract tests | 4 |
| `apps/facilitator/src/adapters/postgres-schema.ts` | migration `0017_account_plans` (table and view) | 4 |
| `apps/facilitator/src/main.ts` (keys script) | `keys plan` | 4 |
| `apps/facilitator/src/spend/policy.ts`, `settlement/hooks.ts`, `settle.ts`, `reasons.ts` | account scopes, refusals with a message | 5 |
| `apps/facilitator/src/settlement/verify.ts` | the balance-missing refusal | 6 |
| `apps/portal/src/app.ts`, `config.ts`, `main.ts` | `details.usage` | 7 |
| `apps/facilitator/src/config.ts`, `packages/metrics-catalog`, `infra/src/lib/alarms/settlement.ts`, docs | config, the alarm's `free`, the pubnet message, docs | 8 |
| `sorobanscan-api-portal`: `src/account/x402/*`, privacy and OpenAPI files | the card | 9 |

---

### Task 1: `spendLimits` takes the traffic it budgets (refactor)

No behaviour change: every existing test stays as it is.

**Files:**
- Modify: `apps/facilitator/src/spend/limits.ts`, `apps/facilitator/src/spend/policy.ts:202-208`
- Test: `apps/facilitator/test/spend-policy.test.ts` (unchanged, must pass)

**Interfaces:**
- Produces: `spendLimits(ctx: { payer: string; payTo: string; asset: string; account?: AccountBudget }, tier: AssetTier, budgets: SpendBudgets): SpendLimit[]`
  and `interface AccountBudget { owner: string; plan: AccountPlan; monthStart: number }`
  (`AccountPlan` comes in Task 4; until then declare it in `limits.ts` as
  `{ name: string; payments: number; dailyFeeStroops: bigint }` and replace it with the import in
  Task 4). With `account` undefined the function returns exactly today's list.

- [ ] **Step 1:** Add the optional `account` field and ignore it. Make `budgetKind` exhaustive
  over the known prefixes and throw on an unknown one, instead of falling through to `asset`.
- [ ] **Step 2:** Run `corepack pnpm --filter @stellar-x402/facilitator test -- spend-policy`.
  Expected: PASS, no test edited.
- [ ] **Step 3:** Commit `refactor(lore-0107): let the scope list take an account`.

### Task 2: each limit reports and prunes by its own window (refactor)

**Files:**
- Modify: `apps/facilitator/src/ports/spend-store.ts` (`ScopeUsage`), `adapters/postgres.ts:897-905`,
  `spend/policy.ts:131-153`, `pruner.ts`, `main.ts:565-577`
- Test: `apps/facilitator/test/spend-policy.test.ts`, `pruner.test.ts`, `main.test.ts`

**Interfaces:**
- Produces: `ScopeUsage.windowMs: number` (the limit's own window), logged by
  `spend_budget_nearing` in place of `budgets.windowMs`; `createPruner`'s `spendWindowMs` documented
  as "the longest window any limit sums".

- [ ] **Step 1: Test first.** In `spend-policy.test.ts` add `"reports nearing with the limit's own
  window"`: a fake store whose `usage` entry has `windowMs: 123` and 80 % used; assert the
  `spend_budget_nearing` line has `windowMs: 123`. Run it: FAIL.
- [ ] **Step 2:** Carry `windowMs` through `reserve`'s usage and the log. Today every limit has
  the one window, so no other assertion changes.
- [ ] **Step 3:** Run `spend-policy`, `pruner`, `main`, `postgres` tests. Expected: PASS.
- [ ] **Step 4:** Commit `refactor(lore-0107): report a budget's own window`.

### Task 3: a count limit in the spend store (logic, high-risk: concurrency)

**Files:**
- Create: `apps/facilitator/src/spend/period.ts`
- Modify: `apps/facilitator/src/ports/spend-store.ts`, `adapters/postgres.ts` (`reserve`)
- Test: `apps/facilitator/test/port-contracts.ts` (`spendStoreContract`), `postgres.test.ts`,
  new `test/period.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ports/spend-store.ts
  export type SpendScope = /* today's */ | "free" | `account:${string}`;
  export type SpendLimit =
    | { scope: SpendScope; maxStroops: bigint; windowMs: number }
    /** At most `maxCount` reservations of the scope stamped at or after `since`, this one included. */
    | { scope: SpendScope; maxCount: number; since: number };
  export interface ScopeUsage { scope: SpendScope; windowMs: number; usedStroops: bigint; maxStroops: bigint } // stroop limits only
  // ReserveResult's refusal gains which limit was full:
  | { reserved: false; scope: SpendScope; limit: "stroops" | "count" }
  // spend/period.ts
  export function monthStart(now: number): number; // 1st 00:00:00.000 UTC of now's month
  export function monthEnd(now: number): number;   // the next month's start
  ```
- A count limit counts rows of `spend_reservation_scopes` with `scope = $1 AND at >= $2`
  (released reservations have none). No migration: index `(scope, at)` serves it.

- [ ] **Step 1: `period.test.ts`.** `monthStart(Date.UTC(2026, 11, 31, 23, 59, 59, 999))` is
  `Date.UTC(2026, 11, 1)`; `monthEnd` of it is `Date.UTC(2027, 0, 1)`; `monthStart` of exactly
  `Date.UTC(2026, 11, 1)` is itself; February of a leap year. Run: FAIL. Implement. PASS.
- [ ] **Step 2: Contract tests, failing first,** in `spendStoreContract`:
  - `"refuses the reservation past a count limit"`: `maxCount: 2`, three ids; the third answers
    `{ reserved: false, scope, limit: "count" }` and reserves in no other limit.
  - `"a released reservation frees its count"`: reserve 2 of 2, release one, a third passes.
  - `"a committed reservation keeps its count"`.
  - `"counts from since, inclusive"` (Review Focus 1): one row at `since - 1`, one at `since`;
    with `maxCount: 1` a new reserve is refused; with `since` moved one millisecond later it
    passes.
  - `"a stroop refusal says limit: stroops"`.
  - `"an account's two limits on one scope"`: a count limit and a stroop limit with the same
    scope in one reservation; the scope row is locked once.
- [ ] **Step 3: Concurrency on PostgreSQL** (`postgres.test.ts`, Review Focus 2): 20 parallel
  reserves with distinct ids against `maxCount: 5`; exactly 5 resolve `reserved: true`.
- [ ] **Step 4:** Implement in `reserve`: a count statement per count limit, in the limits'
  order, under the same locks. Update every `SpendLimit` and `ScopeUsage` user to the union.
- [ ] **Step 5:** Run `postgres`, `spend-policy`, `settle` tests. Expected: PASS.
- [ ] **Step 6: Measure.** A script in `test/live/` or a skipped-by-default test: 100,000 rows in
  one `account:` scope in a month, time 200 reserves. Record the median and p99 in the task's
  README ("Implementation Notes"). Above 50 ms at p99, stop and tell akot: the design's fallback
  B applies to the account scope.
- [ ] **Step 7:** Commit `feat(lore-0107): count reservations against a limit`.

### Task 4: plans (logic)

**Files:**
- Create: `packages/api-keys/src/plans.ts`
- Modify: `packages/api-keys/src/postgres.ts`, `src/index.ts`, `test/testing.ts`,
  `apps/facilitator/src/adapters/postgres-schema.ts` (migration `0017_account_plans`),
  `apps/facilitator/src/main.ts` (keys script, `KEYS_USAGE`)
- Test: `packages/api-keys/test/memory.test.ts`, new `test/plans.test.ts`,
  `apps/facilitator/test/postgres.test.ts`, `migrate.test.ts`, `keys.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AccountPlan { name: string; payments: number; dailyFeeStroops: bigint }
  /** "free:1000:20000000,basic:10000:25000000,pro:100000:100000000". Throws on a bad entry, a duplicate, or no `free`. */
  export function parseAccountPlans(text: string): Map<string, AccountPlan>;
  export const DEFAULT_ACCOUNT_PLANS: string; // the line above
  export interface AccountPlanRecord { owner: string; plan: string; setAt: number; setBy: string; note?: string }
  export interface AccountPlanStore {
    /** The plan name stored for `owner`, or `undefined`: the caller reads that as `free`. */
    planOf(owner: string): Promise<string | undefined>;
    setPlan(row: { owner: string; plan: string; now: number; setBy: string; note?: string }): Promise<void>;
    listPlans(): Promise<AccountPlanRecord[]>;
  }
  export interface AccountUsageReader {
    /** Payments counted for `owner` at or after `since` (the month's start). */
    paymentsSince(owner: string, since: number): Promise<number>;
  }
  ```
- Migration `0017_account_plans`: table `account_plans(owner text PRIMARY KEY, plan text NOT
  NULL, set_at bigint NOT NULL, set_by text NOT NULL, note text)`, and view `account_usage(owner,
  at)` over `spend_reservation_scopes` rows whose scope starts with `account:` (owner is the
  scope without that prefix). `paymentsSince` counts the view's rows.
- Keys script: `keys plan <owner> <plan> [note…]` sets it and prints the row;
  `keys plans` lists rows. `setBy` is `operator:$USER` or `operator:unknown`. It refuses a plan
  the config (`ACCOUNT_PLANS`, Task 8; until then `DEFAULT_ACCOUNT_PLANS`) doesn't name.

- [ ] **Step 1: `plans.test.ts`.** The default line parses to the three plans with the Global
  Constraints' values; `"basic:10"`, `"free:x:1"`, a duplicate name and a list without `free`
  each throw. FAIL, implement, PASS.
- [ ] **Step 2: Store contract** in `test/testing.ts`, run by `memory.test.ts` and the
  facilitator's `postgres.test.ts`: `planOf` of an unknown owner is `undefined`; `setPlan` twice
  keeps the last with its `setBy` and `note`; an owner that isn't `<kind>:<id>` throws
  `RangeError`. And for the reader: three `account:discord:1` rows (one before `since`), one
  `account:discord:2` row; `paymentsSince("discord:1", since)` is 2.
- [ ] **Step 3:** Write the migration; `migrate.test.ts` gets the new name in its list. Run the
  contract on PostgreSQL. PASS.
- [ ] **Step 4: `keys.test.ts`.** `keys plan discord:1 basic asked on Discord` stores it and
  prints it; `keys plan discord:1 gold` fails with the usage and stores nothing; `keys plans`
  lists. Implement. PASS.
- [ ] **Step 5:** Replace Task 1's local `AccountPlan` with the import.
- [ ] **Step 6:** Commit `feat(lore-0107): keep an account's plan in the registry`.

### Task 5: the policy budgets by account (logic, high-risk: money path)

**Files:**
- Modify: `apps/facilitator/src/spend/limits.ts`, `spend/policy.ts`, `settlement/hooks.ts`
  (`BeforeSubmitResult`), `settlement/settle.ts:1052-1067` and `withRetry`,
  `settlement/reasons.ts`, `main.ts` (wiring, pruner window)
- Test: `apps/facilitator/test/spend-policy.test.ts`, `settle.test.ts`, `settle-route.test.ts`

**Interfaces:**
- Consumes: Task 3's limits, Task 4's `AccountPlanStore`, `parseAccountPlans`, `monthStart`,
  `monthEnd`.
- Produces:
  - `SpendBudgets.freeStroops: bigint`; `BudgetKind` gains `"account" | "free"`.
  - `createSpendPolicy` deps gain `plans: Pick<AccountPlanStore, "planOf">`,
    `accountPlans: Map<string, AccountPlan>`, `keyed: boolean` (the network requires a key).
  - `BeforeSubmitResult`'s refusal gains `errorMessage?: string`; `settle` stores it with the
    `rejected` record (`advance` already takes `errorMessage`) and answers it.
  - `SETTLE_REASONS.quotaExhausted`, `.spendLimitAccount`, `.spendLimitFree`.
  - `extra.resetsAt` for `quotaExhausted`: `monthEnd(record.createdAt)` as RFC 3339, set in one
    place for a first answer and a replay (the plan's call; the message's instant comes from
    `ctx.now`, and the two can differ only across the month's first instant).
- Scope list with an account, in this order:
  1. `{ scope: "account:<owner>", maxCount: plan.payments, since: monthStart(now) }`
  2. `{ scope: "account:<owner>", maxStroops: plan.dailyFeeStroops, windowMs }`
  3. `{ scope: "free", maxStroops: budgets.freeStroops, windowMs }`, only for plan `free`
  4. `global`, as today
- Refusal mapping: account + `count` → `quotaExhausted`, message
  `` `the account's monthly quota of ${n} payments is used up until ${iso}; contact us for a higher plan` ``;
  account + `stroops` → `spendLimitAccount`, message `"the account's fee allowance is used up for
  now: its payments cost more than usual; try again later"`; `free` → `spendLimitFree`, message
  `"the free plan's shared allowance is used up for now; try again later, or contact us for a
  higher plan"`.

- [ ] **Step 1: Policy tests, failing first** (a fake store that records `reserve`'s limits):
  - `"a keyed settlement on the free plan reserves account, free and global"`: the four limits
    above in order, with `maxCount: 1000`, `since` the month's start, `maxStroops: 20000000n` and
    `250000000n`; no `payer:`, `payTo:`, `asset:` or `tier:other` (criterion 1).
  - `"a raised account doesn't count in free"`: `planOf` answers `"basic"`; limits are account
    (10,000 and `25000000n`) and `global` (criterion 3).
  - `"a settlement without a caller keeps today's scopes"`: replaces the test at
    `spend-policy.test.ts:192-198`, which pinned "an owner like any other, until 0107".
  - `"a keyed network refuses a settlement without a caller"`: `keyed: true`, no caller →
    `settle_exact_stellar_refused`, `reserve` never called.
  - `"an unknown plan name counts as free and is logged"` (Review Focus 3): `planOf` answers
    `"gold"`; free limits, one `account_plan_unknown` error line.
  - `"a plan read that fails refuses, as a store failure does"`: `planOf` rejects →
    `settle_exact_stellar_spend_store_unavailable` (fail closed; it reopens).
  - one test per refusal mapping, asserting reason and exact message.
  - `"nearing is reported for free and global, not for an account"`.
  - `"a reopen reserves under the reopening caller"`: `reopened: 1`, caller B → id `<key>#1`,
    scope `account:<B>` (decision 9).
- [ ] **Step 2:** Run them: FAIL. Implement `spendLimits`' account branch and the policy.
  Run: PASS.
- [ ] **Step 3: `settle.test.ts`** (PostgreSQL, real spend store), failing first:
  - `"an account past its quota is refused with nothing signed"`: plan of 2 payments; the third
    `/settle` answers `success: false`, `quotaExhausted`, the message, `extra.resetsAt`, and the
    submitter was never called (criterion 2).
  - `"the same payment again answers the same refusal"` (Review Focus 4).
  - `"the quota carries over to a new key"`: 2 payments with owner `discord:1`, then revoke and
    issue in the registry, then a third with the new key → refused (0106's third criterion).
  - `"the month's roll gives the quota back"`: the clock moved to the next month's start →
    settles.
  - `"a raised plan settles at once"`: after the refusal, `setPlan(… "basic")`, a new payment
    settles (criterion 2).
  - `"free accounts fill free; a raised account still settles"`: `freeStroops` of 2 ceilings; two
    free accounts' settlements fill it, a third free account gets `spendLimitFree`, a `basic`
    account settles (criterion 3).
  - `"a failed, included settlement counts as a payment; a refused one doesn't"`.
- [ ] **Step 4:** Implement the stored message and `extra.resetsAt`; wire `main.ts`: `keyed` from
  `requiresApiKey(config.network)`, `plans` on the `apiKeys` pool, and the pruner's window
  `max(config.spend.windowMs, 31 days)` when `keyed`. Update `main.test.ts:582-586` to that rule.
- [ ] **Step 5:** Run the facilitator's whole suite. Expected: PASS (`settle.test.ts`'s "settle
  budget (ADR 0011)" block may fail once in the parallel run, task 0074; run it alone).
- [ ] **Step 6:** Commit `feat(lore-0107): budget a keyed settlement by its account`.

### Task 6: the balance-missing refusal (logic)

**Files:**
- Modify: `apps/facilitator/src/settlement/verify.ts` (beside `withArchivedEntries`),
  `settlement/reasons.ts`
- Test: `apps/facilitator/test/verify.test.ts`, `refusals.test.ts`; new
  `apps/facilitator/test/live/pay-to-balance-missing.ts`

**Interfaces:**
- Produces: `PAY_TO_BALANCE_MISSING = "invalid_exact_stellar_pay_to_balance_missing"`. When
  upstream answers `FEE_EXCEEDS_MAXIMUM`, the transaction lists no archived entries, the asset's
  kind is `sac` and `payTo` starts with `C`: read the SAC's persistent `Balance(payTo)` entry
  (`getLedgerEntries`). Absent → `invalidReason` becomes `PAY_TO_BALANCE_MISSING`, message:
  `"payTo has no balance of this token yet, and its first payment, which creates one, costs more
  than the facilitator pays: send payTo a first amount of the token from your own account, then
  pay again"`. Present, or the read fails → the answer stays as it is. No other path reads the
  entry.

- [ ] **Step 1: Tests, failing first** (`FakeRpc`): the refusal for SAC + C + no entry; unchanged
  answer for a G `payTo`, a wasm token, an entry that exists, a transaction with archived
  entries (0066's message wins), and an RPC error. `/settle`'s re-check answers the same reason.
- [ ] **Step 2:** Implement. Run `verify`, `refusals`, `settle` tests. PASS.
- [ ] **Step 3: Live script** (run by hand, results into the task's README): a local facilitator
  on testnet with `MAX_FEE_STROOPS=100000`; a payment to a fresh C-address is refused with the
  reason; one transfer of the token to that address from another account; the same payment's
  successor settles. If the transfer doesn't create the balance, stop and tell akot: the
  message's fix is wrong.
- [ ] **Step 4:** Commit `feat(lore-0107): say when payTo has no balance yet`.

### Task 7: the portal answers the account's use (logic)

**Files:**
- Modify: `apps/portal/src/app.ts:200-245`, `config.ts`, `main.ts`
- Test: `apps/portal/test/app.test.ts`, `config.test.ts`, `portal.ts` (the test harness)

**Interfaces:**
- Consumes: `AccountPlanStore.planOf`, `AccountUsageReader.paymentsSince`, `parseAccountPlans`;
  `monthStart`/`monthEnd` (move `period.ts` into `packages/api-keys` in this task's first commit,
  a verbatim move with the facilitator's import updated, if the portal can't import it otherwise).
- Produces, in every `account` answer whose key state is `active` or `revoked`:
  ```json
  "details": { "showable": true, "usage": {
    "used": 312, "remaining": 688, "limit": 1000,
    "period_start": "2026-11-01T00:00:00Z", "period_end": "2026-12-01T00:00:00Z",
    "resets_at": "2026-12-01T00:00:00Z", "as_of": "<now>",
    "plan": { "name": "free", "quota_limit": 1000, "quota_period": "month" } } }
  ```
  `remaining` never goes below 0. `usage` is `null` when either read fails (logged
  `hub_usage_unavailable` with `jti` and `act`), and absent for state `none`.
- Config: `ACCOUNT_PLANS`, default `DEFAULT_ACCOUNT_PLANS`.

- [ ] **Step 1: Tests, failing first:** the shape above for 312 payments on `free`; a `basic`
  account's `limit` 10,000; an unknown plan name reads as `free`; `used` above `limit` gives
  `remaining: 0`; the reader rejecting gives `usage: null` with the key still answered (Review
  Focus 5); state `none` has no `usage`.
- [ ] **Step 2:** Implement. Run `corepack pnpm --filter @stellar-x402/portal test`. PASS.
- [ ] **Step 3:** `docs/runbook.md`, "The portal's backend": add
  `GRANT SELECT ON account_plans, account_usage TO x402_portal;` to the role's step, and say it
  is run again on the existing role. `deploy/scripts/check-production-portal.sh` reads the usage
  through the role.
- [ ] **Step 4:** Commit `feat(lore-0107): answer an account's use to the hub`.

### Task 8: config, the alarm, the pubnet message and the docs

**Files:**
- Modify: `apps/facilitator/src/config.ts` (`SPEND_FREE_STROOPS`, `ACCOUNT_PLANS`, lines 365-377),
  `deploy/testnet.env.example`, `deploy/mainnet.env.example`,
  `packages/metrics-catalog/src/index.ts:467-476, 512-535`,
  `infra/src/lib/alarms/settlement.ts:123-131`, `apps/facilitator/README.md`, `apps/portal/README.md`,
  `docs/adr/0007-fee-abuse-containment.md`, `docs/adr/0013-facilitator-key-custody.md`,
  `docs/threat-model.md`, `docs/architecture/m1-spine.md` (AD-11, AD-18), `docs/runbook.md`,
  `lore/1-tasks/backlog/0108_FEATURE_settle-billing.md`
- Test: `apps/facilitator/test/config.test.ts`, `main.test.ts`, the catalog's and infra's tests

- [ ] **Step 1: Config tests, failing first:** `SPEND_FREE_STROOPS` defaults to `250000000n` and
  must be at least `MAX_FEE_STROOPS`; a plan whose `dailyFeeStroops` is below `MAX_FEE_STROOPS`
  is refused; `SPEND_FREE_STROOPS` above `SPEND_GLOBAL_STROOPS` is refused; the pubnet message is
  `"stellar:pubnet is refused until the signer alarm (0027) and the hot key's re-check (0048)
  land"` (criterion 4). First check whether 0027's signer alarm has landed (0027 is archived;
  0139 carries monitoring on): if it has, the message names 0048 alone. Implement. PASS.
- [ ] **Step 2: The alarm.** In the catalog, `spend_budget_nearing_total`'s `when.budget` gains
  `"free"`, and `spend_refused_total`'s reasons gain the three new ones. The alarm's `what` says
  "(asset, other, free or global)". Rebuild the catalog; run its tests, the facilitator's
  `metrics` tests and infra's. PASS.
- [ ] **Step 3: Docs,** each as S-design §11 lists:
  - README (facilitator): the config table, the plans, the reasons table, "what a seller sees
    past its quota", the `keys plan` command.
  - ADR 0007: "Amendment 2026-11-23 (task 0107)".
  - Threat model: "Shared budget exhaustion", "Targeted `payTo`" (moved, not closed), "Fee
    inflation by rent" (443,000 and 382,000 on pubnet), "A key leaks", "A new key for a new
    budget", and a new entry, "A buyer uses up a seller's quota".
  - Spine AD-11 and AD-18.
  - Runbook: granting a plan (check `global ≥ free + the raised accounts' daily budgets`, raise
    `global` and the float when there is no room), the float note, a Logs Insights query for
    `spend_limit_reached` by scope.
  - ADR 0013: pubnet's measured 12,203 beside the 41,200.
  - 0108: the XLM price note.
- [ ] **Step 4:** Run the whole workspace: `corepack pnpm test`, and lint the changed paths.
- [ ] **Step 5:** Commit `feat(lore-0107): configure the plans and the free budget` and
  `docs(lore-0107): describe the account quota`.

### Task 9: the hub's card (sorobanscan-api-portal, a pull request of its own)

After the stellar-x402 pull request is merged and the portal's backend deployed. Branch from the
hub's `main`; its own conventions for commits and plans apply
(`docs/superpowers/plans/2026-11-18-hub-x402-tab-plan.md` is the model).

**Files:**
- Modify: `src/account/x402/api.ts`, `src/account/x402/X402Tab.tsx`,
  `src/prices/privacy/privacy-policy-x402.md`, `public/docs/x402/openapi.json`,
  `bff/test/fake-x402.ts`
- Test: `src/account/x402/X402Tab.spec.tsx`, `bff/test/x402.test.ts`

**Interfaces:**
- Consumes: Task 7's `details.usage`.
- Produces: `X402Account.usage: X402Usage | null | undefined` (absent: an older backend, the
  card then shows today's "Mainnet (pubnet)" text).

- [ ] **Step 1: Tests, failing first:** the tab shows "Monthly Usage · Mainnet" with
  "312 of 1,000", "688" remaining, the reset date and the plan's name; at `used >= limit` the
  strip "Monthly quota reached. Mainnet /settle refuses until <date>. Contact us for a higher
  limit."; `usage: null` shows the Prices card's "couldn't load" state; no `usage` keeps the old
  tile; the Testnet tile is unchanged.
- [ ] **Step 2:** Implement with Prices' `UsageFigures` and `DashboardCard`. The unit shown is
  "payments".
- [ ] **Step 3:** The privacy paragraph: the payments and their fees counted under the Discord
  account ID for about two months, and the plan row (plan, when, by whom, a note). The OpenAPI
  document: the three `/settle` reasons and the `/verify` one.
- [ ] **Step 4:** The hub's checks, then its pull request, when akot says.

---

## Criteria to tests

| Criterion (README) | Test |
|---|---|
| 1. A keyed settlement counts in its account and `global`, not in the shared asset and tier budgets | Task 5, "a keyed settlement on the free plan reserves account, free and global" |
| 2. Past its quota: refused, nothing signed, until the month rolls or the plan is raised | Task 5, "an account past its quota…", "the month's roll…", "a raised plan settles at once" |
| 3. Free accounts fill the shared free budget; a raised account still settles | Task 5, "free accounts fill free; a raised account still settles" |
| 4. The values are config and recorded | Task 8 step 1; the README's config table |
| 5. The hub shows the use (proposed in S-design) | Task 7's shape test; Task 9 step 1 |
| 6. A key's replacement continues the count (proposed) | Task 5, "the quota carries over to a new key" |
| 7. The balance-missing refusal (proposed) | Task 6 steps 1 and 3 |

## After the last task

- `/lore-framework-tasks`: the README's "Implementation Notes", "Issues Encountered", the
  decisions that emerged, criteria ticked with what each rests on.
- `/pr` when akot says; the body says the stack is one pull request with class-ordered commits,
  to be reviewed commit by commit, and marks Tasks 3 and 5 high-risk.
- The task closes only after the hub's pull request (Task 9) is merged.
