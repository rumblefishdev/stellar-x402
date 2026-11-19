---
title: "Budget numbers and edge cases"
type: research
status: mature
tags: [facilitator, fees, budgets]
history:
  - date: "2026-10-29"
    status: mature
    who: akot
    note: "Research for the 0024 design (agent report, read only)."
---

# 0024 research E: budget numbers and edge cases

Inputs read: `lore/1-tasks/backlog/0024_FEATURE_spend-budgets-and-breakers.md`, `0027_FEATURE_alerts-and-metrics.md`,
`docs/adr/0007-fee-abuse-containment.md`, `docs/adr/0013-facilitator-key-custody.md` (fee float),
AD-10/AD-18 in `docs/architecture/m1-spine.md`, `apps/facilitator/src/{ports/spend-store.ts,config.ts,pruner.ts,settlement/hooks.ts,settlement/settle.ts,adapters/postgres.ts,adapters/postgres-schema.ts}`,
`apps/facilitator/README.md` ("/settle answers").

Facts the picks rest on:

- 1 XLM = 10^7 stroops. Ceiling `MAX_FEE_STROOPS` = 250,000 = 0.025 XLM. Live testnet USDC: 14,278 resource fee
  (+2x bid, ~14.5k total). ADR 0003/0013 "typical exact": ~41,200. First-of-day: 151,550.
- **Fee float (ADR 0013): 100 XLM, low-balance alarm at 25 XLM, manual top-ups, testnet uses the same numbers.**
  ADR 0013 sizes it at ~1,000 settlements/day (~4.1 XLM/day at 41.2k).
- XLM in 2026 is around USD 0.1-0.3 (price pages disagree; order of magnitude only). The float is ~USD 10-30,
  so the money is small; **the stake is availability**: an empty float stops every settlement until a person tops it up.
- **Current defaults in `config.ts` exceed the float:** `SPEND_GLOBAL_STROOPS` 5e9 = 500 XLM/day (5x the float),
  per-asset 2e9 = 200 XLM, per-payTo 5e8 = 50 XLM, per-payer 5e7 = 5 XLM, one `SPEND_WINDOW_MS` = 24 h.
  As they stand, the global budget can never trip before the account is empty.
- `reserve` already sums every limit's window inside its transaction (`WINDOW_SUM` per limit), and accepts
  several limits on the same scope with different `windowMs` (scopes are de-duplicated, limits are not).
- `beforeSubmit` runs **after the claim** (settle.ts ~l.733). A thrown hook today ends the record `rejected`
  with `settle_exact_stellar_refused` (200, `success:false`), not a 500.
- `reserve` on an existing id is a no-op that answers `reserved: true` (`ON CONFLICT DO NOTHING`, rowCount 0).
  `release` deletes only `state='reserved'`; the CHECK allows `reserved | committed` only.
- `/settle` runs only on the lease holder (503 `no_lease` elsewhere), so the cross-instance late reserve
  needs a lease handover during a claim: rare, but not impossible.
- The x402 Stellar spec defines only `invalid_exact_stellar_payload_fee_exceeds_maximum`; every
  `settle_exact_stellar_*` reason is ours, so naming is our call. Spec is silent on spend/rate limits.

---

## 1. Numeric defaults and windows

Derivation: global <= float - alarm (75 XLM), so one window can never empty the account and the 80 % budget
alert fires before the low-balance alarm; global >= ~10x the expected 4 XLM/day legit spend; each per-party
budget a fraction of global so no single party can trip it.

Proposed values (testnet T1 and the pubnet starting point are the same, as ADR 0013 does for the float;
the weekly review tunes pubnet):

| Budget | Stroops | XLM / 24 h | At ceiling (250k) | At typical 41.2k | At live USDC ~14.5k |
|---|---|---|---|---|---|
| Global | 500,000,000 | 50 | 2,000 | ~12,100 | ~34,500 |
| Per payer | 20,000,000 | 2 | 80 | ~485 | ~1,380 |
| Per payTo | 100,000,000 | 10 | 400 | ~2,400 | ~6,900 |
| Per asset, SAC | 250,000,000 | 25 | 1,000 | ~6,000 | ~17,000 |
| Per asset, wasm | 20,000,000 | 2 | 80 | ~485 | ~1,380 |
| All wasm assets together (new scope) | 100,000,000 | 10 | 400 | ~2,400 | ~6,900 |

Traffic check: an AI agent paying 1/min all day = 1,440 payments = 0.6-2.1 XLM (fits per-payer at USDC cost;
heavier agents raise it). A popular seller at 10 paid req/s (the README's rate-limit edge) would spend
~1,250 XLM/day, which no 100 XLM float can carry anyway: raising per-payTo is a config change (ADR 0007).

### 1a. Values

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| Keep current defaults (500/5/50/200 XLM) | no change | global is 5x the float, so it never trips before the account is empty; per-asset 200 XLM bounds nothing | 0 files -- Risk: float drained, every seller stopped until a manual top-up | Rec only if the float grows above ~750 XLM |
| Float-derived (50/2/10 XLM, asset 25 SAC / 2 wasm) | global < float - alarm, budget alert precedes balance alarm, 12x headroom over expected traffic, budgets scale with one rule | a heavy agent or seller hits its cap sooner, needs a config raise | `config.ts` defaults + `config.test.ts` + README -- Risk: false refusals for unexpectedly busy sellers | Rec for T1 testnet and as pubnet starting point |
| Express budgets as a fraction of a `FEE_FLOAT_STROOPS` setting | one knob when the float changes | another config value, ratios hide the absolute numbers operators see in alerts | config schema + derivation code -- Risk: misread ratios | Rec if the float is expected to change often after mainnet |

### 1b. Windows

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| One `SPEND_WINDOW_MS` (24 h) for all | as today, pruner already gets it, one number to reason about | a burst can burn the whole global day in minutes (throughput-bound) and leave everyone refused ~24 h | 0 files -- Risk: long DoS after a burst | Rec for T1 and pubnet start |
| A window per budget | per-party windows can be shorter (e.g. payer 1 h) so a legit buyer recovers faster | 4+ more env vars, pruner must get `max(windows)` (0050 note), alerts harder to read | `config.ts`, hook, `main.ts` pruner wiring, tests -- Risk: forgetting the max for the pruner under-counts | Rec if per-party refusals of legit users become common |
| 24 h plus a second, shorter global limit (e.g. 1 h at 20 %) | slows a drain so the 80 % alert leaves time to react, store supports two limits on one scope already | refuses legit peaks sooner, one more pair of values | hook builds two `SpendLimit`s for `global`; pruner still gets 24 h -- Risk: low | Rec if pubnet sees bursts faster than a person responds |

### 1c. Per-asset by asset kind

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| One per-asset value | no lookup | if a wasm `transfer` skips `require_auth`, per-payer bounds nothing for it (0024's open finding); junk wasm tokens share the SAC budget | 0 files -- Risk: junk tokens eat global | Rec only if the `require_auth` finding is disproven and wasm traffic stays rare |
| Tiered: SAC vs wasm per-asset limit | low cap for the class that can fake payers | an attacker deploys N wasm tokens, each with its own cap, and still reaches global | kind lookup (instance `ContractExecutable`, one `getLedgerEntries` per new contract, cached forever: a SAC can't become wasm and `update_current_contract_wasm` never makes a SAC) -- Risk: RPC failure -> treat as wasm | Rec as the minimum |
| Tiered + an aggregate `kind:wasm` scope | many wasm tokens can't reach global, so junk tokens can't refuse USDC sellers | one new `SpendScope` literal (port type), one more limit row per wasm settle | `spend-store.ts` scope type, hook, config (2 vars), tests -- Risk: low; unknown kind must default to wasm | Rec for T1 and pubnet |

**Rationale:** The one hard number in the project is ADR 0013's 100 XLM float with its 25 XLM alarm, and the
global budget is the only thing that bounds a Sybil attacker (payers, payTos and self-issued assets are cheap to
make), so it has to sit below what the float can lose in one window: 50 XLM/24 h keeps one window from emptying
it and makes the 80 % budget alert fire at 40 XLM, before the balance alarm at 75 XLM spent, while leaving ~12x
the ~4 XLM/day ADR 0013 expects. Per-party budgets bound one buggy or hostile party, not a Sybil, so they are
fractions of global sized to legit shapes (an agent at ~1 payment/min fits 2 XLM per payer at USDC cost). One
24 h window keeps the pruner wiring as is; per-asset should be tiered by contract kind with an aggregate wasm
budget, because the unverified `require_auth` gap makes per-payer limits meaningless for wasm and a per-token
cap alone is multiplied by token count.

---

## 2. Reserve amount

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| The ceiling `maxFeeStroops` (250k) | the sum never exceeds a limit (the pool never pays above the ceiling, so commit only lowers it); no fee needed in the hook context; caps parallel bursts per payer (8 in-flight = per-payer 2 XLM), which also blunts 0024's parallel-balance griefing | transient over-count ~17x per in-flight settlement (250k vs ~14.5k) until commit; a lost `onFinal` leaves 250k counted for the window | 0 port changes (context has `maxFeeStroops`) -- Risk: false refusals only near a limit or under heavy parallelism | Rec for T1 and pubnet start |
| This payment's simulated fee | reservations close to the real cost, fewer false refusals near a limit | the pool re-simulates and escalates (`FEE_ESCALATION_*`, `txBadSeq` rebuilds), so commit can raise the sum above the limit; needs the fee passed into `BeforeSubmitContext` | settle.ts + hooks.ts context, tests -- Risk: budget overshoot by (actual - estimate) x in-flight | Rec if per-payer budgets are set close to ceiling x parallelism |
| Simulated fee x escalation worst case, capped at the ceiling | tight and still never overshoots | must mirror the pool's escalation formula; diverges silently if the pool changes | new helper coupled to signer-pool config -- Risk: formula drift | Rec if false refusals at the ceiling show up in metrics |

**Rationale:** Commit replaces the reservation within seconds, so over-reserving costs only transient headroom
(at most in-flight count x 250k, ~1.25 XLM for 50 channels against a 50 XLM global) and a bounded leak on a lost
`onFinal`; under-reserving breaks the invariant that a budget is never exceeded, which is the property AD-18
promises. The ceiling is also what the port's own doc already says ("Fee ceiling reserved before `submit()`").

---

## 3. "Nearing limit" events for 0027

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| `reserve` returns each limit's window sum (already computed in its transaction); the hook emits on crossing 80 % | zero extra queries, exact at the moment of the crossing, covers every scope incl. per-payer | port change (`{reserved: true, usage: {scope, used}[]}`), in-memory store must match; repeat id returns no usage | `spend-store.ts`, `postgres.ts`, memory store, hook, tests -- Risk: low | Rec for T1 |
| Call `used()` after each reserve | no port change | 4-5 extra main-pool queries per settle, racy with other reservations | hook only -- Risk: load on the store under attack, exactly when it matters | Rec only if the port must stay frozen |
| Timer sampler (`GROUP BY scope` over the window every minute) | off the hot path, debounced by construction, can feed a gauge `spend_global_used_ratio` | scans the whole window, needs each scope's limit (kind tier), lags up to a tick | new timer beside the pruner, a new store method -- Risk: scan cost at high volume | Rec as a complement for a global gauge/dashboard |

Event shape (aligned with 0027: low-cardinality labels, never payer/payTo as a dimension; addresses only in the log line):

- log `spend_budget_nearing` {budget: `global|payer|payTo|asset|wasm`, scope, usedStroops, maxStroops, windowMs, threshold: 0.8}
  + `spend_budget_nearing_total{budget}`;
- `spend_refused_total{budget}` on every refusal (100 % is the refusal itself);
- log `spend_breaker_opened` {breaker: `asset|payTo`, scope, failures, until} + `spend_breaker_opened_total{breaker}`;
- `spend_store_failures_total{op, code}` (Q4) and `spend_commit_unmatched_total{state}` (Q5).

Threshold and debounce: one 80 % threshold for every budget; emit when `used_before < 0.8*max <= used_before + amount`,
plus an in-process cooldown per scope (e.g. 15 min, bounded LRU) because commit lowers the sum (ceiling -> actual)
and would make it re-cross. Several processes may each emit once: 0027's alarm uses `sum > 0`. 0027 rules: alarm
on `budget=global` nearing and on any breaker opening; payer/payTo nearing go to the dashboard (a busy seller is
not an incident).

**Rationale:** The sums are already computed under the scope locks, so returning them is the only option that is
both free and exact, and crossing detection on those numbers gives one event per crossing without extra state in
the store.

---

## 4. Store failure on `reserve`

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| Today: hook throws -> `settle_exact_stellar_refused` | no work | README says "an error of ours, tell us" for what is load (55P03 = queue on the global lock) or a blip; a lost COMMIT may leave a reservation that no `onFinal` releases | 0 files -- Risk: misleading reason, leaked reservation | Not recommended |
| Fail-closed: bounded retry with the same id inside the remaining budget, then a dedicated `settle_exact_stellar_spend_store_unavailable` (200, `success:false`, record `rejected`), best-effort `release` | matches `rpc_unavailable`'s pattern and README's 200-for-outcomes rule; a retry with the same id also resolves a lost COMMIT (answers `reserved: true` if it landed); backpressure under load | the payment is ended, the buyer signs a new one; hook needs the deadline in its context | settle.ts reason table, hooks.ts context (`deadline`), hook, README row, tests -- Risk: low | Rec for T1 and pubnet |
| 503 + `Retry-After` | the HTTP status says "try again" | wrong after the claim: the record stays `claimed`, so a repeat replays it and gets `settlement_pending` then `…_timeout`, contradicting the README's "503: nothing was read, repeat the same request"; needs reserve moved before the claim, against the hooks contract and AD-18's place | settle.ts flow reorder, hooks contract, 0009 decisions -- Risk: reservations for payments that are then rejected as replays | Rec only if the reserve moves before the claim |
| Fail-open (allow without a reservation) | no refusal during a store blip | 55P03 happens under flood, exactly when the budget must hold; disables AD-18 at will | hook only -- Risk: unbounded spend | Rejected |

**Rationale:** Because the hook runs after the claim, the payment is already bound to a record, so the honest
answer is a final `success:false` with a reason that tells the seller "ours, transient, sign again later", not a
503 whose README contract is "repeat the same request"; fail-closed keeps AD-18's bound when contention is caused by
the very flood it is meant to stop.

---

## 5. Reserve after release, and commit for an unknown id

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| Kept `released` row (tombstone) | store-level and deterministic; `release` of a missing id inserts the tombstone, so a later `reserve` with that id answers a new `{reserved: false, released: true}`; scope rows are deleted, so window sums and their index never see it; `prune` unchanged (deletes by `at`, horizon >= 7 days >> 80 s settle budget + clock skew) | CHECK constraint migration (0067 online runner), `reserve` must read the conflicting row's state, `release` needs `now` for a tombstone's `at` | `postgres-schema.ts` migration, `postgres.ts` reserve/release, memory store, port types, tests -- Risk: a release must never strip scope rows of a `committed` row | Rec for T1 |
| Hook re-reads the settlement record after `reserve` and releases if it is final | no migration; correct in every order (end-before-read: hook sees final and releases; end-after-read: the other side's `onFinal` runs after the reserve committed and deletes it) | one more records read per settle; relies on both tables being in one Postgres | hook + records port access -- Risk: a failed read must also release | Rec if a constraint migration is unwelcome now |
| Accept the leak | nothing | each occurrence counts up to 250k for 24 h (1.25 % of a 2 XLM per-payer budget); not "forever" since prune removes it | 0 -- Risk: small, only at lease handover | Rec only if 0071 fencing makes handover-during-claim impossible |

Commit for an unknown id (resolves `false`): `onFinal` logs `spend_commit_unmatched` at error level (key,
`feeCharged`, `state: missing|released`) and counts `spend_commit_unmatched_total{state}`; it does not insert.
It only happens after a bug, a pruned row (> 7 days late) or a store restore; the under-count is at most one
fee per case, and inserting needs scopes and a time, i.e. a second write path. A commit on a `released` tombstone
also resolves `false` (a paid fee after a release is the case worth an alarm). Rec inserting from the record's
payer/payTo/asset instead only if restores from backup become routine.

**Rationale:** The tombstone fits the `state` column 0022 already added, keeps the fix inside the store where
idempotency already lives, and costs nothing on the hot path; the prune horizon is four orders of magnitude
longer than any window in which a late reserve can arrive, so tombstones need no prune rule of their own.

---

## 6. Refusal reasons sellers see

| Option | Pros | Cons | Complexity | Recommendation |
|--------|------|------|------------|----------------|
| One opaque `settle_exact_stellar_spend_limit_exceeded` | reveals nothing | the seller can't tell "this buyer, wait" from "you, contact the operator" from "the facilitator, fail over"; one `reason` label hides an attack's shape in 0027 metrics | README row + reason -- Risk: support load | Rec if scope disclosure is judged an oracle risk |
| A closed set by budget kind: `settle_exact_stellar_spend_limit_{global,payer,pay_to,asset}`, `settle_exact_stellar_breaker_open_{asset,pay_to}`, `settle_exact_stellar_spend_store_unavailable`; no addresses, amounts or reset times | each reason maps to who acts; fits `settlement_outcomes_total{reason}` (closed set); the caller already knows its payer/payTo/asset, so naming the kind leaks little, and an attacker can probe it by rotating anyway | 7 reasons to document; reveals global exhaustion (visible to everyone anyway) | settle.ts reason table, hook, README table (replace the "a spend reason" row), tests -- Risk: low | Rec for T1 and pubnet |
| One reason + kind in `errorMessage` | one code, detail for humans | clients can't branch on free text; 0066 kept codes stable and put detail in the message only because the spec fixed the code, which isn't the case here | hook + README -- Risk: low | Rec if keeping the reason list short matters more than branching |

All of them end the payment: README's "sign a new payment later; this one is ended" stays, with a per-kind "what
to do": payer -> the buyer waits for its window; pay_to -> the seller asks the operator to raise its budget;
asset / breaker -> the token is failing or limited, try another asset; global -> the facilitator is saturated,
use another facilitator or wait; store_unavailable -> sign a new payment and try again shortly.
`settle_exact_stellar_refused` keeps its meaning (a bug in the hook).

**Rationale:** The spec defines no settle-time reasons, so the `settle_exact_stellar_*` namespace is ours; a small
closed set by kind lets sellers and the 0027 metrics tell a busy seller from a drain without exposing anything the
caller doesn't already know.

---

Sources:
- [x402 scheme_exact_stellar.md](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md)
- XLM price order of magnitude (pages disagree; used only for magnitude): [MEXC XLM](https://www.mexc.com/price/XLM), [Revolut XLM](https://www.revolut.com/crypto/price/xlm/usd/?amount=100), [Binance TR XLM](https://www.binance.tr/en/price/XLM)
