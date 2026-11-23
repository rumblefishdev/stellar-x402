---
title: "Codebase map for 0107"
type: research
status: mature
tags: [facilitator, fees, budgets, api-keys]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Research for the 0107 design (agent report, read only; key claims checked by hand)."
---

# 0107 Per-key quota and fee budget: codebase map

Read-only research at branch `lore-0107-per-key-fee-quota` (491c68b6, after 0024, 0105 and 0106
landed). Paths are relative to the repository root. "F" = `apps/facilitator`. Every claim below was
read in the current code; 0024's map was used for form only. Checked again by hand for the
design: the reserve and its id (`policy.ts`), the scope list (`limits.ts`), the window sum
(`postgres.ts`), `UNSENT_REASONS`, the caller's path (`hooks.ts`, `admit.ts`) and the pruner's
horizon.

## 0. Headline findings

1. **The budgets are one function and one store call.** `spendLimits()` (`F/src/spend/limits.ts:50-71`)
   builds the scope list; `beforeSubmit` reserves the fee ceiling against all of it in one
   `reserve` (`F/src/spend/policy.ts:202-215`). A new scope is a new entry in that list, a new
   `SpendScope` prefix (`F/src/ports/spend-store.ts:8-9`) and a `budgetKind` case. No table changes
   for a stroop budget: scope rows are free-form text.
2. **`beforeSubmit` already gets the owner** (`ctx.caller.owner`, `F/src/settlement/hooks.ts:10-13, 34`)
   and ignores it: the policy destructures only `key, payer, payTo, asset` (`policy.ts:188`). A test
   pins that it budgets an owner "like any other, until 0107" (`F/test/spend-policy.test.ts:192-198`).
3. **`onFinal` needs no caller.** It commits or releases by reservation id `<key>#<reopened>`
   (`policy.ts:247-258, 307-309`); the store's `commit` rewrites every scope row of that id
   (`F/src/adapters/postgres.ts:920-934`), so an owner scope reserved in `beforeSubmit` is settled
   without knowing the owner.
4. **Every window is one rolling `SPEND_WINDOW_MS` (24 h).** The port already carries a window per
   limit (`SpendLimit.windowMs`, `spend-store.ts:11-20`) and the adapter sums `at > now - windowMs`
   per limit (`postgres.ts:897-905`), but the policy passes the one value to every limit
   (`limits.ts:59`), the nearing log reports it (`policy.ts:149`) and the pruner keeps one horizon
   (`F/src/main.ts:574`, `F/src/pruner.ts:24`).
5. **The store sums stroops only; there is no count.** A "1,000 settlements a month" limit can't be
   a stroop scope: `commit` overwrites the amount on all of a reservation's scope rows with the fee.
   It needs a count limit (a `count(*)` beside `WINDOW_SUM`, `postgres.ts:833-834`), no schema change.
6. **Nothing reads per-owner settings.** The registry answers `ownerOf(hash) → owner | undefined`
   only (`packages/api-keys/src/postgres.ts:32-38`); `api_keys` has no limit column
   (`F/src/adapters/postgres-schema.ts:262-274`). A raised limit needs config or a new table.
7. **`/verify` checks no budget** (`policy.ts:321-327`) and gets no caller (`Verify`,
   `F/src/settlement/verify.ts:118-122`), though the route knows it (`F/src/http/app.ts:284`). An
   owner past its quota passes `/verify`, the seller serves, and `/settle` refuses.
8. **A budget refusal never reopens.** Spend-limit reasons are not in `UNSENT_REASONS`
   (`F/src/settlement/reasons.ts:139-155`), so the same payload gets the stored refusal for ever and
   the answer says "sign a new payment once ledger N has closed" (`settle.ts:316-347`).
9. **No code recognises "creates `payTo`'s balance".** Such a payment is refused only because its
   simulated rent puts the fee over `MAX_FEE_STROOPS`, by upstream's check at `/verify`
   (`invalid_exact_stellar_payload_fee_exceeds_maximum`), or the pool's at `/settle`.

## 1. Scopes, config, windows, storage

### Scopes today (`F/src/spend/limits.ts`)

| Scope string | Built at | Applies to | Config (default, stroops) |
|---|---|---|---|
| `payer:<G/C>` | `payerScope` 27-29 | known asset (USDC) | `SPEND_PER_PAYER_STROOPS` 20,000,000 (2 XLM) |
| `payer:<G/C>/<C…asset>` | same | each other token | same value |
| `payTo:<G/C>` | `payToScope` 36-38 | known asset | `SPEND_PER_PAY_TO_STROOPS` 100,000,000 (10 XLM) |
| `payTo:<G/C>/<C…asset>` | same | each other token | same value |
| `asset:<C…>` | `assetScope` 41-43 | every asset | `SPEND_PER_ASSET_STROOPS` 250,000,000 (known) / `SPEND_PER_ASSET_OTHER_STROOPS` 20,000,000 (other) |
| `tier:other` | `spendLimits` 68 | other tokens only | `SPEND_TIER_OTHER_STROOPS` 100,000,000 (10 XLM) |
| `global` | `spendLimits` 69 | every settlement | `SPEND_GLOBAL_STROOPS` 500,000,000 (50 XLM) |

- Order is narrowest first: payer, payTo, asset, `tier:other`, global (`limits.ts:45-49, 61-70`);
  `reserve` names the first limit that breaches in that order (`postgres.ts:897-905`).
- Tier: USDC (`getUsdcAddress(config.network)`) is `known`, everything else `other`
  (`F/src/main.ts:409-410`, `F/src/spend/asset-kinds.ts:5, 33-39`).
- `budgetKind` (`limits.ts:73-79`) maps a scope to the label/refusal kind and **falls through to
  `asset` for any unknown prefix**; `BudgetKind` is a closed union (21).
- The same scope strings key the breakers (`policy.ts:112-129, 162-182`; `BREAKERS` fixed in code,
  45-63). Budgets and breakers share `spend_scopes` rows.
- Scopes carry no network: each network has its own database (alarm text names
  `x402-db-<network>`); the registry is in testnet's database until pubnet has one (0126).

### Config (`F/src/config.ts`)

| Env | Line | Default | Notes |
|---|---|---|---|
| `SPEND_WINDOW_MS` | 252 | 86,400,000 (24 h) | int ≥ 60,000, no upper bound; "a store window, not a timer" |
| `SPEND_GLOBAL_STROOPS` … `SPEND_TIER_OTHER_STROOPS` | 257-266 | above | `spendStroops`: 1 ≤ v ≤ int64 (58-64) |
| `SPEND_FLOOR_STROOPS` | 271 | 50,000,000 (5 XLM) | not a budget: refuse below it |
| `SPEND_BALANCE_INTERVAL_MS` | 273 | 30,000 | |
| `MAX_FEE_STROOPS` | 184 | 250,000 | `feeStroops`: 100 ≤ v ≤ MAX_SAFE_INTEGER (76-80) |
| `RATE_LIMIT_SETTLE` / `_VERIFY` / `_WINDOW_MS` | 242-248 | 600 / 600 / 60,000 | settle ≥ verify (327-330) |

- Every name in `SPEND_BUDGET_VARS` (67-74) must be ≥ `MAX_FEE_STROOPS` (`superRefine`, 355-364):
  a settlement reserves the ceiling. A count quota can't join that list as is.
- Pubnet is refused, naming 0107 (365-377).
- Mapped into `Config.spend` (423-434, 560-570) and from there into `SpendBudgets` in `main.ts:412-420`
  (`perAssetStroops` → `perKnownAssetStroops`).
- Breakers are code, not config: `BREAKER_FAILURES`/`BREAKER_COOLDOWN_MS` are refused (283-285, 343-351).
- Documented in `F/README.md:194-209` and `deploy/testnet.env.example:29-40`.

### Window semantics

- Rolling, not fixed: a limit sums scope rows with `at > now - windowMs` (`WINDOW_SUM`,
  `postgres.ts:833-834`, used at 897-905). `at` is the reservation's `ctx.now`; `commit` keeps it
  (`spend-store.ts:67-73`), so a late commit counts in the window of its reserve.
- Rows stamped after `now` count too (`spend-store.ts:13-17`).
- Breaker counts use a different, tumbling window per scope (`spend-store.ts:102-112`,
  `postgres.ts` `WINDOW_ENDED`).

### Storage (PostgreSQL only; migrations in `F/src/adapters/postgres-schema.ts`)

| Migration | Lines | What |
|---|---|---|
| `0001_init` | 87-110 | `spend_reservations(id PK, amount, at, state)`, `spend_reservation_scopes(scope, id FK CASCADE)`, `spend_scopes(scope PK, failures, breaker_until)` |
| `0004_spend_window` | 123-137 | scope rows get `at`, `amount`; index `(scope, at) INCLUDE (amount)` |
| `0009_spend_budgets` | 206-223 | state gains `released`; `spend_scopes` gains `window_start, successes, strikes, last_opened_at` |
| `0011_settlement_in_flight` | 230-247 | one non-final settlement per `(network, payer, asset)` |
| `0013_api_keys` | 256-275 | registry, see section 7 |

- Migrations that touch the spend tables lock them in `reserve`'s order (header, 14-20).
- Pruning: reservations and quiescent scope rows older than `spendHorizonMs(window) = max(2×window,
  7 d)` (`F/src/pruner.ts:18-24, 96-110`); one `spendWindowMs` from `main.ts:574`.

## 2. A reservation, end to end

| Step | Where | What |
|---|---|---|
| Claim | `F/src/settlement/settle.ts:946-1001` | insert-if-absent of `network:payer:nonce` (or `reopen`), taking the `(network,payer,asset)` slot; busy → wait, past budget `…_payer_busy` |
| Hook call | `settle.ts:1024-1051` | `beforeSubmit` bounded by what is left of `SETTLE_BUDGET_MS`; `caller` added at 1042, `reopened` at 1040, `maxFeeStroops` at 1037 |
| Floor | `policy.ts:189` | below the floor → `…_facilitator_underfunded`, nothing reserved |
| Breakers | `policy.ts:191-200` | one read of open breakers; a store error → `…_spend_store_unavailable` |
| Reserve | `policy.ts:202-228` | id `<key>#<reopened>`; amount **`ctx.maxFeeStroops`, the ceiling (250,000)**, not an estimate; limits from `spendLimits`; retries every 200 ms on a store error until `ctx.deadline` |
| Adapter | `postgres.ts:856-918` | one transaction on the `reserve` pool, `lock_timeout` 2 s (805); insert id (a repeat is a no-op, a `released` id refuses); upsert-and-lock every scope row in sorted order (`global` on every call); sum each limit; breach rolls back |
| Submit | `settle.ts:1071-1072` | only after an allow; the pool simulates, signs and sends inside `submit()` |
| Final | `records.ts:117-121` | `onFinal(record)` once for the writer that made the record final, fire-and-forget (`runHook`, 61-68) |
| Settle up | `policy.ts:247-258` | `feeCharged` set (`success`, `failed`) → `commit(id, fee)`; else (`rejected`, `expired`) → `release(id)`. Unmatched commit → `spend_commit_unmatched` |

- **Failed settlements count**: an included failure has `feeCharged` and is committed like a success.
  `rejected` and `expired` are released, so a refused or unsent settlement costs no budget.
- `feeCharged` is the fee bump's `feeCharged()` (`packages/signer-pool/src/submitter.ts:1044`); a
  rewrap under someone else's bump commits 0 (1078).
- `release` keeps a `released` tombstone and deletes the scope rows (`postgres.ts:940-953`), so a
  `reserve` arriving after it is refused (`ReserveResult.released`, `spend-store.ts:44-45`) and
  `beforeSubmit` answers `…_refused` (`policy.ts:217`).

### Crash or restart between reserve and final

- **Before a hash is stored**: the record stays `claimed`. Reconciliation ends it `rejected
  …_interrupted` after `createdAt + budgetMs + 5 s` and runs `onFinal` → release
  (`F/src/settlement/reconcile.ts:236-253`). `…_interrupted` is unsent, so the identical payload can
  reopen and reserve again under `<key>#<n+1>`.
- **After a hash**: reconciliation resolves the hash, the final write runs `onFinal` → commit or release.
- **`onFinal` lost**: only a final write whose answer was lost is retried, from an in-memory
  `unconfirmed` set that a restart forgets (`records.ts:184-221`, `reconcile.ts:171-179`). The
  reservation then counts at the ceiling until it leaves the window (24 h today; a month for a
  monthly owner window).
- **Lost `reserve` answer**: retried with the same id (idempotent); after the deadline the policy
  releases the id itself (`policy.ts:229-236`), since a refusal gets no `onFinal`.
- **Hook past the budget**: `outOfBudget` → `endUnsigned` runs `onFinal` only after the hook's promise
  settles, so a late reservation is released (`settle.ts:381-405, 1009-1022`).

## 3. Repeats and reopens

- **Repeat of a known payload** (`settle.ts:820-826`): the stored record is read first; if it isn't
  reopenable the call replays it (`replay`, `settle.ts:733-804`): no checks, **no `beforeSubmit`, no reservation**.
  A `success` is answered once; a later caller gets `…_already_settled` (AD-6).
- **Reopen** (`reopenable`, `settle.ts:1176-1184`): same fingerprint, `rejected` with an unsent reason
  and no hash, `reopened ≥ 0`. The store bumps `reopened` and `version` and retakes the payer slot
  (`postgres.ts:595-623`). Then `beforeSubmit` runs as for a first claim, with
  `reopened = n+1`, so the reservation id is new (`<key>#<n+1>`) and scopes are computed again.
- **Whose caller**: the request that wins the claim or the reopen; hooks.ts:30-34 says a repeat or
  reopen carries its own request's caller. The first claim's reservation was already released by
  its `onFinal` (or never made: floor refusal), so a reopen charges only the reopener.
- **Which refusals reopen**: `UNSENT_REASONS` (`reasons.ts:139-155`) includes
  `…_facilitator_underfunded` and `…_spend_store_unavailable`, not the `…_spend_limit_*` or
  `…_breaker_open_*` ones. Edge: a store-unavailable refusal whose own release failed leaves
  `<key>#n` reserved until the window ends.
- **Nothing stores the owner with the settlement**: `settlements` has no owner column; only the scope
  rows in `spend_reservation_scopes` would (`owner:…` as the scope string).

## 4. How `caller` reaches the policy

| Step | Where |
|---|---|
| Network decides: pubnet needs a key | `F/src/http/api-key.ts:22` (`requiresApiKey`) |
| `Authorization: Bearer x402_…` parsed | `api-key.ts:5-15` |
| Registry read on every request, `ownerOf(sha256)` on the `apiKeys` pool (3 conns) | `F/src/http/admit.ts:87-91`; pool `main.ts:521`, store `postgres.ts:82` |
| 401 `missing_api_key` / `invalid_api_key`, counted nowhere | `admit.ts:49-56, 88-91` |
| Rate limit by owner, `<route>:key:<owner>`, fixed window | `admit.ts:92`; `F/src/http/rate-limit.ts:31-35, 100` |
| `res.locals.caller = { owner }` | `admit.ts:93`, read by `callerOf` 99-100 |
| `/settle` passes it as the 4th argument | `app.ts:298-314` (`settle(payload, req, signal, callerOf(res))`) |
| `Settle` → `settle(…, caller, …)` | `settle.ts:161-166, 806-812, 1104-1110` |
| Into the context, only when present | `settle.ts:1041-1042`; type `Caller { owner }` `hooks.ts:10-13`, field `hooks.ts:34` |

- Testnet: `admit` counts by IP and sets no caller (`admit.ts:82-85`), so `ctx.caller` is absent.
- Only `app.ts:309` calls `Settle` (grep of `F/src`), so on pubnet `caller` is always set.
- `onFinal(record, origin)` (`hooks.ts:88`) gets no caller, and the record has none.
- Logs `verified` and `settled` carry `caller` (`app.ts:284, 327`); `rate_limited` carries `owner`.

## 5. How a refusal is expressed

- `beforeSubmit` refuses with `{ allow: false, errorReason }` (`hooks.ts:49-58`). Settle moves the
  record `claimed → rejected` with that reason, without `onFinal`, and answers **HTTP 200,
  `success: false`, `errorReason`** (`settle.ts:1052-1067`). A throwing hook → `…_refused`
  (1048-1050). Nothing has been signed: submit comes after (1072).
- `withRetry` adds to the answer `extra.retryable: false`, `extra.expirationLedger` and the advice
  "the auth entry may still land in ledger N: sign a new payment once that ledger has closed"
  (`settle.ts:316-347`), because budget reasons are neither unsent nor in `NOT_SIGN_AGAIN`
  (`reasons.ts:166-172`).
- Every refusal increments `spend_refused_total{reason}` (`policy.ts:107-110`).

| Reason (`reasons.ts`) | Line | Cause |
|---|---|---|
| `settle_exact_stellar_spend_limit_payer` | 104 | payer budget |
| `settle_exact_stellar_spend_limit_pay_to` | 106 | payTo budget |
| `settle_exact_stellar_spend_limit_asset` | 108 | asset budget (and today any unknown scope, via `budgetKind`) |
| `settle_exact_stellar_spend_limit_other` | 110 | `tier:other` |
| `settle_exact_stellar_spend_limit_global` | 112 | `global` |
| `settle_exact_stellar_breaker_open_{payer,pay_to,asset}` | 114-118 | breakers (also on `/verify`) |
| `settle_exact_stellar_spend_store_unavailable` | 123 | store didn't answer (unsent, reopens) |
| `settle_exact_stellar_facilitator_underfunded` | 125 | floor (unsent, reopens) |
| `settle_exact_stellar_refused` | 46 | hook threw, or reserve after release |
| `invalid_exact_stellar_payload_fee_exceeds_maximum` | `verify.ts:502` | upstream fee check (`/verify` and `/settle`'s re-check) |
| `settle_exact_stellar_fee_exceeds_maximum` | 29 | pool's `FeeLimitError` (`settle.ts:1234`); in `REFUSED_AFTER_VERIFY` (`settle.ts:78-83`) |

- `/verify` refuses only for an open breaker, with a fixed message (`policy.ts:311-360`).
- README's reason table: `F/README.md:553-557`; runbook text 245-305.

## 6. Events and metrics (0027)

| Signal | Where | Notes |
|---|---|---|
| log `spend_budget_nearing` (warn) | `policy.ts:131-153` | at ≥ 80 % of a limit after a reserve, from `ReserveResult.usage`; 15-min cooldown per scope; in-memory map, 10,000 scopes max (78-83); logs `scope, used, max, windowMs` (one `windowMs` for all) |
| `spend_budget_nearing_total{budget}` | same, 151 | catalog writes a series only for `asset`, `other`, `global` (`packages/metrics-catalog/src/index.ts:467-476`); alarm `budget-nearing` (`infra/src/lib/alarms/settlement.ts:123-131`) |
| log `spend_limit_reached` (info) | `policy.ts:218` | key and scope |
| `spend_refused_total{reason}` | `policy.ts:108` | `reason` a log field with a closed value list (catalog 512-535); no alarm |
| log `spend_breaker_opened`, `spend_breaker_opened_total{breaker}` | `policy.ts:180-181` | catalog 452-464 |
| `spend_store_failures_total{op}`, log `spend_store_failed` | `policy.ts:196, 223, 234` | |
| `spend_commit_unmatched_total{state}`, log (error) | `policy.ts:256-257` | |
| `fee_charged_stroops{state}` | `records.ts:76-79` | once per final write |

Label values are typed against the catalog (`F/src/metrics.ts:15-22`): a new budget kind or
reason needs catalog entries, or it lands in `other`.

## 7. The fee ceiling and the new-balance payment

- `MAX_FEE_STROOPS` 250,000 (`config.ts:184`) feeds three places through `feeSettings`
  (`F/src/settlement/fees.ts:30-44`): upstream verify's `maxTransactionFeeStroops`
  (`F/src/settlement/upstream.ts:94`), the pool's `maxFee` (`submitter.ts:369`), and the reservation
  (`main.ts:266` → `settle.ts:1037` → `policy.ts:205`).
- **Estimate**: the transaction's simulated `minResourceFee` (resources plus any rent for new or
  restored entries) plus the inclusion fee paid twice under a fee bump (`fees.ts:46-53`). Upstream
  checks `minResourceFee + inclusionFee > max` with `inclusionFee = 2×bid` (`@x402/stellar` 2.31.0
  `dist/esm/exact/facilitator/index.mjs:372-379`; bid via `atCurrentBid`, `fees.ts:65-74`). The pool
  re-simulates and checks `resource + 2×bid > maxFee`, lowering a raised bid first
  (`submitter.ts:735-745`). `INCLUSION_FEE_STROOPS × 2 < MAX_FEE_STROOPS` (`config.ts:300-305`).
- **Creating `payTo`'s balance**: no dedicated check. Its rent (~443,000 stroops for USDC to a fresh
  C-address on pubnet, `lore/3-wiki/R-pubnet-new-balance-rent.md`) fails the upstream fee check at
  `/verify` (and `/settle`'s re-check), so the refusal names only fee and ceiling. The only
  archived-entry detail added is for restores (`verify.ts:479-499`). `trustline.ts` names a missing
  classic trustline (SAC error 13), not a missing contract balance.
- Raising the ceiling raises every reservation: the amount reserved is always `maxFeeStroops`, not
  the simulated fee, and every budget must stay ≥ the ceiling (`config.ts:355-364`).

## 8. The API key registry

- Package `packages/api-keys`: `ApiKeyStore` (`src/store.ts:22-39`: `ownerOf`, `issue`, `revoke`,
  `list`), `PostgresApiKeyStore` (`src/postgres.ts:26-90`), `SealedKeyStore` for the portal (93-170),
  owner rule `^[a-z]+:[a-z0-9][a-z0-9_-]*$`, ≤ 128 chars (`src/rules.ts:5-12`).
- Table `api_keys(key_hash PK, owner, state active|revoked, created_at, revoked_at)` with one active
  key per owner (`postgres-schema.ts:262-274`); `api_key_copies` for the portal (282-288).
- Revoke: `state = 'revoked'`, `revoked_at` set; holds from the next request since `ownerOf` reads
  `state = 'active'` every time. Operator CLI `pnpm keys issue|revoke|list` (`main.ts:654-737`).
- The portal's role `x402_portal` can touch only `api_keys` and `api_key_copies`
  (`docs/runbook.md:1120-1122`): showing an owner's use (0106: "`details` holds no use (0107)",
  `apps/portal/src/app.ts:228-244`) would need a read grant on the spend tables, or another source.
- **No per-owner settings anywhere in the facilitator.** `Caller` has `owner` only; the `admit` read
  returns the owner only.

## 9. Concurrency that matters for an owner scope

- Every `reserve` locks `global` (`postgres.ts:885-893`), so reservations already serialize there; a
  shared free scope adds a second always-locked row but no new serialization.
- Each limit's sum runs under those locks: a monthly scope that every free owner shares sums a month
  of rows on every reserve (index-only where visible, `postgres.ts:827-834`), where `global` sums one
  day. Not measured; the 0050 numbers are for 24 h windows.
- One non-final settlement per `(network, payer, asset)` (`0011`, `postgres.ts:308-332`), nothing per
  owner: one owner may have as many settlements in flight as it has payers.

## What 0107 needs to change

**Seams that take it without a rebuild**

1. **Scope type and kinds**: add `owner:<owner>` and a shared free scope to `SpendScope`
   (`spend-store.ts:8-9`), new `BudgetKind`s (`limits.ts:21`), `budgetKind` cases (73-79; the
   fall-through to `asset` would otherwise mislabel them), and their reasons in `SETTLE_REASONS`
   (`reasons.ts:100-112`) and `SPEND_LIMIT_REASONS` (`limits.ts:81-87`). The owner string is safe in a
   scope: lower-case, `:`-separated, ≤ 128 chars.
2. **The scope list**: `spendLimits` (`limits.ts:50-71`) takes the caller and its limits, and for
   keyed traffic emits owner (stroops), the shared free scope when the owner isn't raised, and
   `global`, without `asset:` and `tier:other` (criterion 1). Whether payer and payTo stay is the
   open decision. The breakers' scopes are built separately (`policy.ts:116-122`) and are unaffected.
3. **The policy call**: pass `ctx.caller` into `spendLimits` (`policy.ts:202-208`). `onFinal` stays as
   it is.
4. **A count limit**: add `maxCount` (or a limit kind) to `SpendLimit` and a count query next to
   `WINDOW_SUM` in `reserve` (`postgres.ts:897-905`). Released rows are deleted, committed ones stay,
   so the count is "reserved or included", failed included. No migration: the window index
   `(scope, at)` serves a count.
5. **The month**: per-limit windows are already in the port. Rolling 30 days is just another
   `windowMs`. A calendar month needs a start instead (`SpendLimit.since`, or `windowMs = now −
   start of month UTC`, which the current adapter accepts as is).
6. **Config**: new `SPEND_*` vars and their `Config.spend` fields (`config.ts:251-273, 423-434,
   560-570`); a count var can't go in `SPEND_BUDGET_VARS`' ceiling rule (67-74, 355-364). Narrow the
   pubnet message (365-377).
7. **Per-owner overrides**: either config (e.g. a map of owner → limits, parsed in `config.ts`) or a
   new table read with the owner (`admit` → `Caller`, `admit.ts:90-93`, `hooks.ts:10-13`), on the
   `apiKeys` pool, or in `beforeSubmit` on the `reserve` pool. A new table is a new migration
   (`0017_…`), additive.
8. **Pruner**: give it the longest window of all limits (`main.ts:565-577`); a monthly window keeps
   rows `max(2×31 d, 7 d)` = 62 days (`pruner.ts:24`). Test `F/test/main.test.ts:582-586` assumes one
   window.
9. **Events**: `nearing` must log each limit's own window, not `budgets.windowMs` (`policy.ts:149`), and
   needs the count in `ScopeUsage` (`spend-store.ts:33-37`) for a count limit. Catalog entries for
   the new kinds and reasons (`metrics-catalog/src/index.ts:467-535`), and the `budget-nearing`
   alarm's text (`infra/src/lib/alarms/settlement.ts:123-131`).
10. **`/verify`** (optional): to refuse an owner past its quota before the seller serves, `Verify`
    needs the caller (`verify.ts:118-122`) and `verifyWithBreakers` a `used()` read
    (`spend-store.ts:82`).
11. **A caller-less `/settle` on pubnet**: the policy should refuse or scope it when
    `ctx.network` is pubnet and `ctx.caller` is undefined (0107 Implementation; nothing checks it today).

**What would fight it**

- Refusals don't reopen: a quota refusal answered like the spend limits leaves the payload dead even
  after the operator raises the limit. Making it reopen means adding it to `UNSENT_REASONS`, which
  0024 kept for transient misses only.
- The ceiling reservation: at 250,000 a reservation, a fee budget of 1,000 ceilings is 2.5 × 10⁸
  stroops (25 XLM) per owner, and a lost `onFinal` holds a ceiling for the rest of the month.
- A shared monthly free scope sums the most rows of any limit, under `global`'s lock with a 2 s lock
  timeout. Not measured.
- Tests that pin today's behaviour: `F/test/spend-policy.test.ts:192-198` (owner budgeted like any
  other), the `budgets` fixture (32-40), `F/test/settle.test.ts:370-381` (caller passed, absent on
  testnet), `spendStoreContract` in `F/test/port-contracts.ts`.

**Not confirmed here**: the cost of a month-long window sum at production volumes; whether
`windowMs = now − month start` near the month's first millisecond meets any adapter guard (none seen
in `reserve`); the hub BFF's side of showing use (another repo).
