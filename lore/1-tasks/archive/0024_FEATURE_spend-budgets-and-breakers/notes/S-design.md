---
title: "0024 design: spend budgets, payer proof and attributed breakers"
type: synthesis
status: mature
spawns: []
history:
  - date: "2026-10-30"
    status: mature
    who: akot
    note: "Design accepted by akot; builder-checked; payer proof confirmed on testnet."
  - date: "2026-11-03"
    status: mature
    who: akot
    note: "Residual risk: option 3 chosen for pubnet (API keys, M2), see the task's decision 31."
tags: [facilitator, fees, budgets, breakers, security]
---

# 0024 design: spend budgets, payer proof and attributed breakers

Research behind it: [R-codebase-map](R-codebase-map.md) (A), [R-parallel-spend](R-parallel-spend.md)
(B), [R-breakers](R-breakers.md) (C), [R-wasm-auth](R-wasm-auth.md) (D),
[R-budgets-and-edges](R-budgets-and-edges.md) (E), [R-prior-art](R-prior-art.md) (F); letters as
cited below.

## Intent

The facilitator pays every fee (AD-10), takes no API key on `/settle` and accepts any SEP-41 token
(ADR 0007). Anyone can drain its XLM with valid payments: self-payments, junk tokens, payments that
pass both simulations and fail on chain, or N payments that spend one balance in parallel. 0024
bounds that loss **without an allowlist and without API keys**, and without giving an attacker a
switch that refuses other people's payments. When it lands, `stellar:pubnet` no longer waits for
budgets, but still waits for 0071 and for caller authentication or pricing (section 11).

The bar is "a bit better than every facilitator we surveyed"
([R-facilitator-survey](R-facilitator-survey.md)): nobody there has breakers or failure
attribution, nobody budgets per asset or in fees over a rolling window in a shared store, nobody
controls parallel spend per payer, and nobody detects a token that skips the payer's auth.

## Goals

1. **Bound total loss** below the fee float (ADR 0013: 100 XLM, alarm at 25), with the global and
   per-asset budgets as the guarantee. They bound loss, not availability (see "Residual risk").
2. **Make the payer a proven identity**, so per-payer budgets and breakers mean something.
3. **Stop parallel spend of one balance at the source.**
4. **Breakers that only the party at fault can trip.**
5. **Account exactly**: reserve before submit, settle at the fee actually charged, failures included,
   each reservation resolved once.
6. **Tell operators early** (events for 0027) and **tell callers precisely** (one reason per cause).

## Non-goals

- Token allowlist, required API keys, per-caller identities (ADR 0007; 0060 later).
- Budgets for `/verify` (it spends nothing).
- Recovering an `onFinal` lost in a crash (acceptable for T1; the reservation ages out).
- Balance-aware parallelism (in-flight amounts against the payer's balance). A follow-up if
  `payer_busy` hurts real fan-out traffic.

## Anti-goals (failure even if it works)

- One payer address, one seller address or one cheap token can make USDC, or another seller,
  refuse everyone's payments. (Many addresses together can: an accepted residual, see "Residual
  risk".)
- A budget is exceeded under concurrency, or a fee paid on chain is missing from every window.
- The store failing open: no reservation, yet the payment settles.
- A legitimate payment refused with a reason that tells the caller nothing actionable.

## Constraints (from the code)

- Order in `settle()` (`apps/facilitator/src/settlement/settle.ts` ~657-799): known-key lookup →
  `check` (upstream simulation) → `claim` → `beforeSubmit` → `submit` (the pool re-simulates in
  enforce mode, then `expectTransfer`, then sends) → final record → `onFinal`.
- A `beforeSubmit` refusal or throw ends the record `rejected` and skips `onFinal`
  (`settle.ts:750-766`). The buyer signs a new payment, as for every other settle refusal. A claimed
  record is never re-run, so "503, retry the same request" is impossible after the claim.
- `onFinal` gets the `SettlementRecord`; `feeCharged` is set only for `success` and `failed`.
  `payTo` and `asset` are in `record.paymentRequirements`. Reconciliation finalises through the same
  hooks object (`main.ts:382`).
- Only the lease holder settles (0025); fencing is 0071. The store is PostgreSQL only (0064 removed
  the memory store); tests run on PostgreSQL.
- `SpendStore` (`ports/spend-store.ts`, `adapters/postgres.ts:533-668`): atomic multi-scope
  `reserve` with `lock_timeout` 2 s, every reserve locks `global`; `commit` resolves `false` for an
  unknown id; `release` deletes only `reserved`; `recordFailure` ignores `now`.
- The pool keeps only the transaction-level result code (`txFailed`) and drops even that for
  `failed` before the store (`records.ts:189-191`).
- Upstream checks only that the payer's signature is non-void; Soroban checks an auth entry and
  consumes its nonce only when `require_auth` uses it ([R-wasm-auth](R-wasm-auth.md)). A wasm `transfer` that never
  calls `from.require_auth()` settles **successfully** with any `from`.
- Metrics labels come from closed sets only; addresses go in log lines (`metrics.ts`).

## Design

### Flow

```
/settle
  check (upstream, unchanged) + amount > 0
  claim  ── single-flight per (network, payer, asset): wait within the budget, else payer_busy (no record)
  beforeSubmit (SpendPolicy)
     balance floor ─ breakers (payer, payTo, wasm asset) ─ asset kind ─ reserve(ceiling, scopes)
  submit (pool)
     enforce simulation ─ expectTransfer + payer proof (nonce key in read-write footprint) ─ send
     result: op result code + diagnostic error, when present
  final record (failure cause stored)
  onFinal (SpendPolicy)
     commit(feeCharged) | release ─ attribute failure ─ breakers ─ events
```

### 1. Payer proof (closes the `require_auth` gap)

In `expectTransfer` (the pool's enforce simulation at `/settle`), require that the simulation's
read-write footprint contains the payer's nonce key:
`ContractData{contract: payer, key: ScVal::LedgerKeyNonce{nonce}, durability: Temporary}`.
The host writes it only when the payer's entry was matched by a `require_auth`, authenticated
(signature or `__check_auth`) and its nonce was fresh; a contract cannot write that key. Works for G
and C payers, SAC and wasm, credentials v1 and v2. No extra RPC; refuses before anything is signed,
so no fee. New reason `settle_exact_stellar_payer_not_authorized`.

`/verify` stays upstream's: a forged payment there can only be a self-dealing seller's own asset,
and `/settle` refuses it at no cost (**my call**).

Spike (2026-10-30, [R-spike-payer-proof](R-spike-payer-proof.md)): on testnet a token without
`require_auth` passed upstream verify and **settled** with a never-signing victim as payer (fee
paid by the facilitator); the payer's nonce key was in the read-write footprint for honest
test-token and XLM SAC payments and absent for the forged one. So the hole is real and the check
separates the cases.

Verification in the implementation: a testnet e2e with that token variant must be refused at
`/settle`; a normal test-token and USDC payment must pass; a C-account payer must pass.

### 2. Zero amount

The shared checker (`settlement/verify.ts`, both routes) refuses `amount == 0` with
`invalid_exact_stellar_payload_amount_zero`. No configurable minimum in 0024 (**my call**: a
minimum in token units is per token and needs a table; zero is the case with no legitimate use).

### 3. Single-flight per (network, payer, asset)

At most one non-final settlement (`claimed | signed | pending`) per (network, payer, asset),
enforced by PostgreSQL inside `claim`'s transaction through a small separate table keyed by
(network, payer, asset), inserted with the claim and deleted when the record turns final (**my
call**: `settlements` is never pruned and online migrations wait for 0080, so a unique index built
on it in one transaction could exceed the 1.5 s write-lock limit). A conflict is a new `claim`
result `busy` with no record written. Reconciliation and the final write keep the table in step;
the builder decides how a row orphaned by a crash is cleared (e.g. the claim's own final state).

On `busy`, `settle` waits for the blocker to turn final and claims again, polling as `replay` does,
within the remaining settle budget. Past it, it answers `settle_exact_stellar_payer_busy`, retryable
**with the same payment** (no record exists). The pool's re-simulation after a successful claim
sees the previous transfer's effect, so a payment the balance no longer covers is refused for free.

Why in `claim`, not the hook: a hook refusal ends the record and costs the buyer a re-sign; a
`claim` refusal leaves the payment intact. Why a DB constraint: it holds across a lease hand-over.

### 4. Asset kind and budget tier

Two separate facts:

- **Kind** (`sac | wasm`), for attribution: a SAC's code is the host's, so its transfer failures are
  never the token's fault. Computed locally for configured assets (`Asset.contractId(passphrase)`),
  otherwise one `getLedgerEntries` of the contract instance reading `ContractExecutable`; cached in
  process for good (neither kind changes); an RPC failure is `wasm`, not cached.
- **Tier** (`known | other`), for budgets: `known` = the configured SAC assets (USDC per network;
  `Asset.native()` is not a payment asset here). Everything else, a self-issued SAC as much as a wasm
  token, is `other`: anyone can mint it, so it gets the low tier (**my call**, from research D §5.2).
  This limits spend, not acceptance, so ADR 0007's "no allowlist" holds: any SEP-41 token still
  settles.

Used by the policy before reserving and by attribution in `onFinal`.

### 5. Budgets

Scopes (one `SpendLimit` each, one rolling window `SPEND_WINDOW_MS`, 24 h):

| Scope | Default (stroops) | XLM |
|---|---|---|
| `global` | 500,000,000 | 50 |
| `payer:<addr>` (known-tier assets) | 20,000,000 | 2 |
| `payer:<addr>/<C…>` (each other-tier asset) | 20,000,000 | 2 |
| `payTo:<addr>` | 100,000,000 | 10 |
| `asset:<C…>`, known tier | 250,000,000 | 25 |
| `asset:<C…>`, other tier | 20,000,000 | 2 |
| `tier:other` (new scope: all other-tier assets together) | 100,000,000 | 10 |

Rationale: global ≤ float − alarm (75 XLM), so one window can't empty the account and the 80 % alert
(40 XLM) fires before the balance alarm; ~12× ADR 0013's expected 4 XLM/day. Per-payer and
per-`payTo` are Sybil-weak secondary bounds (identities are free); ADR 0007 records that.
`tier:other` stops many minted tokens (wasm or self-issued SAC) from reaching `global`, so junk
tokens can't refuse USDC sellers. The payer scope is split per other-tier asset (**my call**, from
research C and D), so a seller's own token can't use up or trip a buyer's USDC scope. Values are
config, recorded in the task; same for testnet and the pubnet start.

Reservation amount: the ceiling `maxFeeStroops` (the pool never pays more, so a commit only lowers
the sum and a budget is never exceeded).

`reserve` is called with the scope order `payer, payTo, asset, tier:other, global` so the refusal
names the narrowest budget.

Config: every `SPEND_*_STROOPS` bounded to int64; new `SPEND_PER_ASSET_OTHER_STROOPS`,
`SPEND_TIER_OTHER_STROOPS`; documented in the README and `deploy/*.env.example`. The pruner keeps getting
the one window.

### 6. Accounting and exactly-once

- **Reserve** in `beforeSubmit` after the breaker and floor checks. The reservation id is the
  settlement key.
- **`onFinal`**: `feeCharged` set (success, failed) → `commit(key, feeCharged)`; otherwise
  `release(key)`. A pending settlement has no `onFinal` until it turns final, so it stays reserved
  (the "unknown outcome" leg of upstream SVM's three-way rule).
- **Released tombstone**: the reservation state gains `released`. `release` of a reserved row turns
  it `released` and drops its scope rows; `release` of a missing id inserts a `released` row; a later
  `reserve` with that id answers `{reserved: false, released: true}` and counts nothing. A `commit`
  on a `released` row resolves `false`. `prune` unchanged.
- **`commit` resolves `false`**: log `spend_commit_unmatched` at error level and count
  `spend_commit_unmatched_total{state}`; never insert.
- **Store failure on `reserve`**: retry with the same id within the remaining budget (also resolves
  a lost COMMIT answer), then refuse with `settle_exact_stellar_spend_store_unavailable` and release
  best-effort. Fail closed. The hook context gains the deadline.
- **A hook that reserved and then refuses** releases itself.

### 7. Failure attribution and breakers

**Data.** The pool decodes, for an included failed transaction, the `InvokeHostFunction` result
code and, when the RPC returns diagnostic events, the first `Error(type, code)` and the contract of
the failing frame. It travels `SubmitResult` → the final record (new nullable field) → `onFinal`,
on both the settle and the reconcile path. 0024 records it; it is shown in no answer.

**Only included, charged failures count.** `rejected`, `expired`, refusals before submit and timeouts
never reach a breaker.

**Attribution** (pure function, table-tested):

| Signal | At fault |
|---|---|
| `Error(Auth, …)`, failing frame is the payer's contract, SAC error 5/9/10, SAC 11/13 on `from` | payer |
| SAC 11/13 on `to` | payTo |
| failing frame is a wasm token, or `RESOURCE_LIMIT_EXCEEDED` / `INSUFFICIENT_REFUNDABLE_FEE` on a wasm token | asset and payer |
| SAC, `RESOURCE_LIMIT_EXCEEDED` / `INSUFFICIENT_REFUNDABLE_FEE` / `ENTRY_ARCHIVED` | ours: event only |
| unknown (no diagnostics) | payer, plus the asset if wasm; never payTo |

**Breakers** (all state in `spend_scopes`, shared by instances):

| Scope | Opens at | Window | First open | Repeat | Cap |
|---|---|---|---|---|---|
| payer (same key as its budget: `payer:<addr>`, or `payer:<addr>/<C…>` for an other-tier asset) | 3 attributed failures; 1 for an auth failure in a C-account frame | 1 h | 1 h | ×4 | 24 h |
| payTo | 3 attributed failures | 1 h | 1 h | ×4 | 24 h |
| wasm asset | ≥ 5 attributed failures and failures ≥ successes in the window | 10 min | 10 min | ×2 | 6 h |
| SAC asset | never | | | | |

Half-open without new state: strikes stay after a breaker closes; the next attributed failure
reopens it at the next step; 24 h without an opening clears the strikes.

Port changes: `recordFailure(scope, now, windowMs)` counts within a window; `recordSuccess(scope,
now, windowMs)` counts successes (for the wasm ratio) instead of resetting; `openBreaker(scope, now,
policy)` computes the end with backoff in one statement and adds a strike only if the breaker isn't
open. The builder shapes the exact signatures.

`beforeSubmit` refuses when the payer's, the payTo's or (wasm) the asset's breaker is open.
`/verify` also refuses on an open breaker (one read), so a seller doesn't serve a payment `/settle`
will refuse (**my call**). Budgets are not checked at `/verify`.

### 8. Balance floor

The facilitator's fee account balance is read in the background (interval and cache are the
builder's) and `beforeSubmit` refuses below `SPEND_FLOOR_STROOPS` (default 50,000,000 = 5 XLM,
below ADR 0013's alarms; 25 XLM until 0027 decision 7) with `settle_exact_stellar_facilitator_underfunded`. A failed read keeps the last
value; with none yet, refuse (fail closed). An event fires on crossing.

### 9. Events and metrics (for 0027)

- `reserve` returns each limit's window sum (already computed under its locks).
- `spend_budget_nearing` log + `spend_budget_nearing_total{budget}` when a sum crosses 80 %, with a
  15 min in-process cooldown per scope. `budget` ∈ `global | payer | pay_to | asset | other`.
- `spend_refused_total{reason}`, `spend_breaker_opened` log + `spend_breaker_opened_total{breaker}`,
  `spend_failure_attributed_total{fault}`, `spend_store_failures_total{op}`,
  `spend_commit_unmatched_total{state}`, `facilitator_underfunded` log.
- Addresses only in log lines.

### 10. Refusal reasons

| Reason | Where | Same payment again? | Who acts |
|---|---|---|---|
| `invalid_exact_stellar_payload_amount_zero` | verify, settle | no | buyer |
| `settle_exact_stellar_payer_busy` | settle (no record) | **yes** | buyer: resend |
| `settle_exact_stellar_payer_not_authorized` | settle | no | buyer's wallet or token |
| `settle_exact_stellar_spend_limit_{payer,pay_to,asset,other,global}` | settle | no | buyer waits / seller asks operator / try another asset / use another facilitator |
| `settle_exact_stellar_breaker_open_{payer,pay_to,asset}` (also as verify refusals) | verify, settle | no | as above |
| `settle_exact_stellar_spend_store_unavailable` | settle | no, sign a new one shortly | – |
| `settle_exact_stellar_facilitator_underfunded` | settle | no | operator |

No addresses, amounts or reset times in reasons. `settle_exact_stellar_refused` keeps meaning a bug
in the hook. The README table replaces its "a spend reason" row with these.

### 11. Docs and gating

- `config.ts`: the pubnet rule no longer names 0024, but it does not wait for 0071 alone: it also
  waits for caller authentication with per-key fee budgets, or per-settle pricing (the residual risk
  below; decided by the user on 2026-10-30, against the task's "whichever of the two lands last
  removes it"). Message, README and `config.test.ts` / `main.test.ts` follow; 0071's task text is
  updated so landing it doesn't remove the rule.
- ADR 0007 amendment: payer proof, tiers, attributed breakers, Sybil-weak per-party budgets.
- Spine AD-18 updated; threat model entries for parallel spend, `require_auth` skip, breaker abuse.
- Facilitator README: config table, reasons, "what a seller sees when a budget refuses".

## Residual risk: Sybil exhaustion of shared budgets (decided: accept)

**The case.** An attacker pays themself valid USDC payments (1 unit, the value comes back) from
many cheap addresses. Personal budgets (payer, payTo) stop each address, but the shared ones
(`asset:USDC`, `tier:other`, `global`) sum over everyone. With the defaults, about 13 payer and 3
payTo addresses close USDC for every seller: ~17,200 payments at 14.5k stroops, about 30 min with
50 channels or 2.4 h with 10. The addresses' reserves (~1.5 XLM each) come back on merge, and
keeping USDC closed takes ~0.2 payments/s as the window rolls. All payments succeed, so no breaker
opens. `global` itself is out of reach while USDC is the only known asset (25 + 10 < 50).

**Options weighed** (survey: nobody solves this without identity or price):
1. Accept and document. **Chosen** by the user (2026-10-30).
2. A separate share of the asset budgets for `payTo`s with an established history: stops an
   unprepared attack from closing established sellers, not a patient one who ages addresses for a
   day. Not done.
3. API keys with their own budget, or per-settle pricing (CDP, PayAI, OZ Channels, Launchtube):
   the only real fix. It belongs with caller authentication (0060) and mainnet pricing, which the
   RFP ("Testnet must be free; mainnet pricing configurable") and M1 (mainnet pricing out of T1)
   place after T1.

**Why accepting is right for 0024.** It is what the AC asks ("over any budget, `/settle` returns
`success: false`"). It is strictly better than no budget: without one the same attack empties the
100 XLM float and stops everything until a manual top-up; with one the loss stops at 25 XLM
(USDC) + 10 XLM (other tokens) per window and nothing needs a top-up. On testnet the XLM is free.

**What 0024 ships for it:**
- the threat model entry ("Shared budget exhaustion by Sybil self-payments"): the case above, its
  cost, and that caller authentication or pricing closes it;
- an ADR 0007 note: per-party budgets bound one identity, shared budgets bound the loss, and
  shared budgets are an availability lever until callers are authenticated;
- the 80 % `spend_budget_nearing` alert on shared budgets (`asset`, `other`, `global`) as the
  operator's signal;
- a README runbook: how to tell this case from real traffic (many payers, few `payTo`s, 1-unit
  amounts, from the `settled` logs), what raising a limit costs, and that the window rolls;
- a note in 0060 that a known key can later get its own fee budget, apart from the shared ones.

**Update 2026-11-03 (akot):** option 3 is chosen for pubnet, in M2. Pubnet's `/verify` and
`/settle` require an API key from our portal after Discord sign-in, and each account has a free
quota and a fee budget apart from the shared ones; charging past the quota comes later. Testnet
ignores a key and keeps the accepted residual. The task's decision 31 and tasks 0105–0108 hold the
detail. The "30 min with 50 channels" above needs about 50 payers: one payment per payer is in
flight, so 13 payers take about two hours (decision 32).

## Delivery

One task, several reviewable PRs in risk order (`risk-split-pr`):
1. payer proof + zero amount (security, small);
2. store: tombstone, windowed breaker counters, usage from `reserve`, `tier:other` scope (port +
   adapter + contract tests);
3. pool: failure cause decoding and its path to the record;
4. single-flight in `claim`;
5. `SpendPolicy` (asset kind, budgets, breakers, floor, events), wiring in `main.ts`, config,
   reasons, docs, pubnet gate.

Testnet evidence for the PR: a normal payment, a parallel-spend burst answered `payer_busy` with
no failed transaction, the no-auth token refused, a budget refusal, a wasm breaker opening.

## Left to the builder

- Exact port signatures, schema and migration form (within the online-migration rules).
- The poll interval for `busy` and for the balance reader.
- Where `SpendPolicy` and `AssetKinds` live in `apps/facilitator/src`.
- Test layout (PostgreSQL per file, fake submitter, `FakeRpc` additions for op results and
  diagnostics).

## Calls I made (to check)

1. `/verify` doesn't run the payer proof; `/settle` does.
2. Zero is refused; no configurable minimum.
3. `payer_busy` waits within the budget before refusing (a2), rather than refusing at once.
4. One 24 h window for every budget.
5. Reserve at the ceiling, not the simulated fee.
6. `/verify` refuses on open breakers, not on budgets.
7. The balance floor refuses below 5 XLM (25 XLM until 0027 decision 7) and fails closed without
   a first reading.
8. Defaults are the same on testnet and the pubnet start.
9. Budget tier is `known` (configured SAC assets) vs `other` (any other SAC or wasm), separate from
   the SAC/wasm kind used for attribution.
10. The payer scope is split per other-tier asset (`payer:<addr>/<C…>`), for budgets and breakers.
11. Single-flight lives in its own table, not an index on `settlements`.
