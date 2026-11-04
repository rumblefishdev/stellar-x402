---
id: "0024"
title: "Spend budgets and circuit breakers"
type: FEATURE
status: active
milestone: 1
related_adr: ["0007"]
related_tasks: ["0073", "0012", "0017", "0009"]
tags: [facilitator, security, fees, priority-high, effort-medium, platform]
links:
  - ../../../../docs/planning/m1-epics.md
  - ../../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.3 (Platform lane)."
  - date: "2026-10-30"
    status: active
    who: akot
    note: "Work started."
  - date: "2026-11-03"
    status: active
    who: akot
    note: "API keys on pubnet chosen (decision 31); spawned 0105-0108."
  - date: "2026-11-04"
    status: active
    who: akot
    note: "Karol's PR #105 review: decisions 33-44, 0097 taken in, front-run probe on testnet."
---

# Spend budgets and circuit breakers

## Summary

As a facilitator operator, I want fee spending capped and failing assets or recipients cut off, so that nobody can drain the facilitator's XLM with valid self-payments or junk tokens.

**Story:** [M1 Story 2.3](../../../../docs/planning/m1-epics.md#story-23-spend-budgets-and-circuit-breakers) · **Lane:** Platform · **Covers:** FR13 (AD-18)

## Design

Accepted on 2026-10-30: [S-design](notes/S-design.md) (one task, payer proof, single-flight per
(payer, asset), tiered budgets, attributed breakers, balance floor; Sybil exhaustion of shared
budgets accepted; the pubnet rule also waits for API keys with fee budgets of their own,
decision 31). Research in
`notes/`: the codebase map, parallel spend, breakers, the `require_auth` gap, budget numbers,
prior art, a [facilitator survey](notes/R-facilitator-survey.md) and a
[testnet spike](notes/R-spike-payer-proof.md) that confirmed the gap and the fix.

## Context

- IP limits can't stop drain through valid payments; this can (ADR 0007).
- Plugs into the before-submit hook from 1.1, so it can be built and tested with a fake settle before 0009 is done.
- Related tasks: 0017, 0009.

## Implementation

- `SpendBudgets` policy module behind `SpendStore`, wired to the before-submit hook in the composition root.
- Breakers per asset and per `payTo`, fed by settlement outcomes.
- Tests with the in-memory store and a fake settle.
- Decide what `SpendStore.commit` does for an id with no reservation (0017, Oskar's PR #11
  review): the in-memory store ignores it and the port says nothing. `onFinal` is its only
  caller and runs once at a final state, so it only happens after a bug or a lost store.
  Resolving `false` lets the caller log it; inserting the spend needs the scopes. 0022 now
  resolves `false` (its decision 17); what the caller does with it is still this task's.
- A lost `onFinal` call after a crash leaves the reservation counted until it ages out of the
  rolling window; acceptable for T1 (0017, Stan's PR #7 review).
- Option from 0022's third review, to verify rather than a decision (a better approach may exist): `release` is an unconditional DELETE. Releasing a reservation that was already committed
  (a duplicate final call, or a re-check that reclassifies a landed transaction) removes a fee
  that was actually paid from every budget window. One option: a `committed` flag on
  `spend_reservations`, with `release` deleting only `WHERE NOT committed` and `commit` returning
  whether a row matched. This goes with the open decision on `commit` for an unknown id above,
  and with 0009's "refuse a reserve after its release": a reservation status
  (`reserved | committed | released`) kept as a row instead of deleting it would cover both.
  0022 took the status (its decision 17): `state` is `reserved` or `committed`, `release` deletes
  only `reserved` rows, and `commit` resolves `false` for an unknown id. Refusing a reserve after
  its release is still open here; it can add `released` as a kept row.
- From 0022: `reserve` can reject when the store is busy or unreachable (`55P03` after the 2 s lock
  timeout, no `reservePool` connection within 5 s, a lost `COMMIT` answer). Answer it on purpose,
  e.g. 503 with a retry, not 500; a retry with the same `id` is safe, as the port says.
- From 0009 (PR #41 reviews):
  - **`beforeSubmit` must answer within the settle budget.** Past it, the record ends with
    `…_timeout`, and `onFinal` runs once the hook's promise settles, whatever it answered (0009
    decision 34), so a reservation made late is released. `onFinal` may also come for a
    reservation that was never made: a refusal the store couldn't record ends later with
    `onFinal` (`hooks.ts`).
  - **Fee griefing by spending one balance in parallel** (Adam, third review). One payer funded
    with exactly one `amount` signs N payments with N nonces and sends N `/settle` calls at once.
    Each passes both simulations, N channels submit in one ledger, and N−1 fail on chain, at our
    fee. A local probe had two payments from one payer reach `submitter.submit` concurrently.
    The per-asset breaker makes it worse: 6 parallel calls would open the USDC breaker for every
    seller for 10 minutes, at will. Needs: at most one non-final settlement per (payer, asset), or
    in-flight amounts reserved against the balance; and balance-race failures counted against the
    payer, not the asset.
  - **Key a reservation by the settlement key, and refuse a reserve after its release** (Adam,
    fourth review). In one process a repeat leaves an unsigned record to the first call until the
    first call's budget ends (0009 decision 46). Across instances (0022) a repeat judges that by
    its own clock, so it may end the record, and run `onFinal`, before the first call's
    `beforeSubmit` reserves. Then the late reserve must be refused, not counted forever.
  - **A reopened record claims again** (0073 decisions 5, 16). A record closed with nothing
    sent (`…_timeout`, `…_interrupted`, …) goes back to `claimed` when the identical payload
    returns while its auth entry is valid, and `beforeSubmit` runs again. The earlier claim's
    `onFinal` is not awaited, so it may release after the new claim reserves. Key a reservation
    by the settlement key and the record's `reopened` count (in `BeforeSubmitContext` and on the
    record), not by the key alone; "refuse a reserve after its release" then holds per claim.
    `onFinal` isn't exactly once per claim (0073 decision 26): a claim's final write whose answer
    was lost may never get its call if a later claim finishes first, and across processes a
    claim's call can repeat. So a release must be idempotent, and a reservation `onFinal` never
    released needs its own expiry.
  - Refusal reasons are an `errorReason` sellers see; the README lists "a spend reason" as a
    refusal that ends the payment (sign a new one later).
- From 0009 (Adam's sixth PR #41 review), **to verify on a Soroban host first**, not a decision:
  upstream checks only that the payer's auth entry has a non-void signature, and Soroban checks it
  (and uses up the nonce) only when `require_auth` uses the entry. So a wasm token whose `transfer`
  never calls `from.require_auth()` would pass both simulations with any `from` and any nonce. Not
  reproduced: there was no local Soroban host. If it holds, per-payer budgets bound nothing for such
  tokens (ADR 0007's rationale), the global budget becomes a way to refuse every seller, and records
  and the catalog carry a payer the attacker picked. Adam's idea: limits tiered by asset kind, SAC
  (`ContractExecutable::StellarAsset`) against wasm, with low defaults for wasm.
- From 0009 (Adam's seventh PR #41 review): **fees burnt by payments that pass every check.** A
  C-address payer whose `__check_auth` depends on the PRNG or the ledger number passes both
  simulations and `expectTransfer`, then fails on chain at our fee, with no balance spent and no
  parallel spend. Zero-amount transfers (`amount: "0"`) are the same class. Per-payer single-flight
  and balance reservation don't stop it; it needs per-`payTo` and global fee budgets.
- From 0009 (PR #41, decision 49): the config refuses `NETWORK=stellar:pubnet` until spend
  budgets (0024) and the channel lease (0025) land (rate limits, 0023, and store pruning, 0050,
  already have): the rule after the `STORE` one in `config.ts`, with tests in `config.test.ts`
  and `main.test.ts`. Whichever of the two lands last removes it; the other narrows its message
  to what is still missing, together with the facilitator README. *Since 0025 (PR #70, Adam's
  review):* the lease landed, and its fencing token (0071) took its place, so the rule waited
  for budgets (0024) and fencing (0071). *Since 0071 (PR #92, Adam's review):* fencing landed, and
  it waits for budgets (0024) and for skipping a channel with an open hash (0090).
- From 0050 (Oskar's PR #61 review): **the pruner's `spendWindowMs` must be the longest budget
  window.** `main()` passes `config.spend.windowMs` to `createPruner`, which keeps reservations
  for `max(2 × window, 7 days)`; a budget summing a longer window would lose its oldest spend to
  the pruner and under-count. If budgets get windows of their own, pass the longest of them.

## Limits

Recorded per the last criterion. Every budget sums one rolling window, `SPEND_WINDOW_MS`
(86 400 000, 24 h). Same defaults on testnet and at the pubnet start; all are config
([facilitator README](../../../../apps/facilitator/README.md#spend-budgets-and-breakers),
`deploy/*.env.example`).

| Env var                         | Default (stroops) | XLM | Scope                                                     |
| ------------------------------- | ----------------- | --- | --------------------------------------------------------- |
| `SPEND_GLOBAL_STROOPS`          | 500 000 000       | 50  | `global`                                                  |
| `SPEND_PER_PAYER_STROOPS`       | 20 000 000        | 2   | `payer:<addr>` (known assets), `payer:<addr>/<C…>` (each other asset) |
| `SPEND_PER_PAY_TO_STROOPS`      | 100 000 000       | 10  | `payTo:<addr>` (known assets), `payTo:<addr>/<C…>` (each other asset) |
| `SPEND_PER_ASSET_STROOPS`       | 250 000 000       | 25  | `asset:<C…>`, known tier (USDC)                           |
| `SPEND_PER_ASSET_OTHER_STROOPS` | 20 000 000        | 2   | `asset:<C…>`, other tier                                  |
| `SPEND_TIER_OTHER_STROOPS`      | 100 000 000       | 10  | `tier:other`, every other asset together                  |
| `SPEND_FLOOR_STROOPS`           | 50 000 000        | 5   | the fee account's floor on its spendable balance, below ADR 0013's alarms |
| `SPEND_BALANCE_INTERVAL_MS`     | 30 000            |     | how often the floor reads the balance; a reading 10 intervals old (at least 5 min) fails closed (44) |

Breakers are fixed in code (`apps/facilitator/src/spend/policy.ts`, `BREAKERS`):

| Breaker    | Opens at                                                   | Window | First | Repeat | Cap  |
| ---------- | ---------------------------------------------------------- | ------ | ----- | ------ | ---- |
| payer      | 3 attributed failures; 1 in a C-account payer's own contract | 1 h    | 1 h   | ×4     | 24 h |
| payTo      | 3 attributed failures (keyed by tier, like its budget)     | 1 h    | 1 h   | ×4     | 24 h |
| wasm asset | 5 attributed failures and failures ≥ successes             | 10 min | 10 min | ×2     | 6 h  |
| SAC asset  | never                                                      |        |       |        |      |

`BREAKER_FAILURES` and `BREAKER_COOLDOWN_MS` are no longer read; a leftover one refuses to start.
Every budget must be at least `MAX_FEE_STROOPS` (a settlement reserves the ceiling), or the
facilitator refuses to start.

## Design Decisions

### From the design ([S-design](notes/S-design.md), "Calls I made")

1. **Payer proof at `/settle` only**: the payer's nonce key must be in the settlement
   simulation's read-write footprint. `/verify` stays upstream's: a forged payment there can only
   be a self-dealing seller's own token, and `/settle` refuses it at no cost.
2. **Zero amount refused** on both routes; no configurable minimum.
3. **Single-flight per (network, payer, asset)** in `claim`, in its own table, not an index on
   `settlements`. `payer_busy` waits within the settle budget before it refuses, and records
   nothing, so the same payment can be sent again.
4. **One 24 h window** for every budget, so the pruner keeps getting the one window.
5. **Reserve at the ceiling** (`MAX_FEE_STROOPS`), not the simulated fee: a commit only lowers
   the sum, so no budget is exceeded.
6. **`/verify` refuses on open breakers, not on budgets.**
7. **The balance floor** refuses below 5 XLM and fails closed without a first reading. It was
   25 XLM, ADR 0013's alarm, so the alarm fired as settlement stopped; 0027 decision 7 lowered it
   on 2026-11-03 (akot). 5 XLM covers the fees in flight, about 1.25 XLM at 50 channels.
8. **Same defaults** on testnet and at the pubnet start.
9. **Tier (`known | other`) apart from kind (`sac | wasm`)**: the tier picks the budgets, the kind
   the attribution. A self-issued SAC is `other`.
10. **The payer scope is split per other-tier asset**, for budgets and breakers alike.
11. **Sybil exhaustion of the shared budgets is accepted** (akot, 2026-10-30) and documented: the
    threat model entry, ADR 0007's amendment, the 80 % alert, a README runbook and a note in 0060.
    *Since 31:* accepted on testnet only.
12. **The pubnet rule no longer names 0024**, but doesn't wait for 0071 alone either: it also
    waits for caller authentication with per-key fee budgets (0060) or per-settle pricing (akot,
    2026-10-30, against this task's "whichever of the two lands last removes it"). **Landing 0071
    no longer lifts it.** 0071's task text isn't edited here (another person's active task); the
    rule's comment in `config.ts` and the facilitator README say so. *Since 31:* "0060 or
    pricing" became 0105 and 0107.

### From the implementation (rulings)

13. **`FailureCause.error.type`** is the `ScErrorType` switch name (`sceAuth`, `sceContract`, …);
    the code a string; `opCode` the `InvokeHostFunctionResultCode` switch name.
14. **`SETTLE_REASONS` stays a flat object of strings**, with explicit keys for each spend reason,
    and `spendLimitReason(kind)` maps a budget kind to its reason.
15. **`config.spend` keeps env-shaped names** (`perAssetStroops` is the known tier); `compose`
    maps them onto the policy's `SpendBudgets`.
16. **"Auth failure in a C-account payer's frame"** means the payer is a `C…` address and the error
    is `sceAuth`, or the failing contract is the payer. *Narrowed by 23.*
17. **`recordFailure` returns `lastOpenedAt`**, so the policy judges whether strikes are fresh.
18. **SAC errors 11/13 blame `payTo` only when the event names `payTo` and not the payer**; every
    other SAC contract error blames the payer, so one payer can't trip a seller's breaker.
    *Narrowed by 24.*
19. **`breakerRefusal` reads up to three scope rows in parallel** (primary-key lookups), within the
    design's "one read" in cost. *Since 41:* one `breakersOpen` query for all of them.
20. **Payer and `payTo` strikes reset 24 h after the last opening**, so after a 24 h opening a party
    needs three fresh failures to reopen at 1 h.
21. **`/verify` treats a breaker store failure as no open breaker**: it answers upstream's verdict,
    logs it and counts `spend_store_failures_total{op:"breaker"}`. `/verify` spends nothing and
    `/settle` checks again, failing closed. Breakers are read only for a payment every other check
    accepted.
22. **The balance floor reads the facilitator key's account**, the one that signs every fee bump,
    and starts with the server, before the lease is taken, so the first `/settle` has a reading.

### From the final review (rulings 15–18)

23. **A reused nonce feeds no breaker** (ruling 15): `Error(Auth, ExistingValue)` means someone
    holding the payload (the seller, say) submitted it first; the fee still counts against the
    budgets. The threshold of 1 applies only when the failing contract is the `C…` payer itself;
    any other auth error takes the usual 3. Costs a flaky smart wallet three failures, not one.
    *Since 43:* the payer's-frame rule stays ahead of this one, as testnet shows a front-run
    names the token.
24. **SAC 11/13 blame `payTo` only for a known asset** (ruling 16): anyone can wrap a classic
    asset they issue and deauthorize a seller, so on another token the payer is blamed. Costs a
    missed `payTo` breaker for a seller really deauthorized on a self-issued SAC.
25. **`payTo`'s budget and breaker are keyed by tier** (ruling 17): `payTo:<addr>` for the known
    assets, `payTo:<addr>/<asset>` for each other one, so junk tokens can't fill or trip a seller's
    USDC scope (`tier:other` still caps them). Sybil payers in USDC can still fill a seller's USDC
    `payTo` budget: accepted, documented in the threat model.
26. **The rest of the final review in one wave** (ruling 18): `failureCause` reads only
    host-emitted (diagnostic) error events and keeps at most 8 distinct addresses; a SAC resource
    overrun with a `C…` payer is the payer's (its `__check_auth` ran); the floor compares the
    spendable balance (balance minus reserve and selling liabilities); the config refuses a budget
    below `MAX_FEE_STROOPS`; `0009_spend_budgets` (`0006` then) adds its CHECK `NOT VALID` (unreleased, so edited in place);
    docs reworded (ADR 0007, threat model, facilitator README).

### From the merge with develop (0071, 0073, 0078)

27. **A reopened record takes its payer's slot.** 0073 moves a final record back to `claimed`,
    which skipped `settlement_in_flight`, so a payment that reopened could settle next to another
    of its payer and asset: the parallel spend the slot exists to stop. `reopen` takes the slot in
    its transaction, or answers `busy` and rolls back, and `/settle` waits as a new claim waits.
    Past the budget it answers `…_payer_busy` and the record stays closed, so the same payment
    can reopen later. Six tests failed before the fixes in 27 and 28.
28. **A reservation is per claim**: `<key>#<reopened>` (`reservationId`), as 0073 decisions 16 and
    26 asked. An earlier claim's late `onFinal` gives up only its own reservation, and a reserve
    is refused after its own claim's release. `release` was idempotent already, and a reservation
    no `onFinal` reaches leaves the rolling window. A repeated `onFinal` of a charged failure
    would count twice towards a breaker; accepted, since a reopened claim charges nothing and
    only a lost final-write answer repeats it.
29. **The migrations are `0009`–`0011`**: `0007_settlement_reopened` and `0008_lease_token` are on
    develop, and #89 keeps `0006` (0073 decision 27).
30. **The pubnet rule waits for 0090, and for 0060 or pricing**: 0071 landed, and this task
    narrows the message rather than lifting the rule (12). *Since 31:* for 0090, 0105 and 0107, and 0036's 0027 and 0048.

### From the discussion of the shared budgets (2026-11-03)

31. **API keys on pubnet, in M2** (akot, 2026-11-03; ADR 0007's amendment of that date). On
    pubnet `/verify` and `/settle` require an API key from our portal, issued after Discord sign-in
    as stellar-prices-api does (0105, 0106); each account gets a free quota (1,000 settlements a
    month, Coinbase CDP's model) and a fee budget apart from the shared ones (0107); charging past
    it ($0.001 a settlement) comes later and doesn't block pubnet (0108). Testnet ignores a key
    and stays as it is, so T1's acceptance needs nothing more. Nothing in the RFP or the M1 plan
    asks for an open `/settle` on mainnet: the keyless "gate proxy" is our conformance harness
    (0028). The pubnet rule now names 0090, 0105 and 0107, next to 0036's 0027 and
    0048.
32. **The docs' numbers for the Sybil case are corrected**: with one payment per payer in flight,
    13 payers fill `asset:USDC` in about two hours, and half an hour needs about 50 payers. The
    budgets bound the rate, not the sum: kept up for under three days, the attack takes the float
    to its 5 XLM floor, and `facilitator_underfunded` refuses every payment; the README runbook
    says so.

### From the code review (2026-11-03, `f1329ae`)

33. **A record whose history is gone frees its payer's slot** (`freeInFlight` in `reconcile.ts`).
    It can't land again past its bound, so holding the slot would answer every later payment of
    that payer and asset `payer_busy` for good. The record itself stays open for the operator
    (0009 decision 22's check on an explorer).
34. **An asset breaker opens only on a confirmed wasm kind** (`AssetKinds.confirmed`). An RPC
    error, a timeout (5 s) or a missing instance entry answers `wasm` unconfirmed and isn't
    cached, so a SAC whose kind couldn't be read never gets a breaker: the failure is logged
    `spend_asset_kind_unconfirmed` and still feeds the payer's. The kind cache keeps 50,000
    assets, the oldest forgotten first.
35. **Which spend refusals end a payment.** A budget (`…_spend_limit_*`) or a breaker
    (`…_breaker_open_*`) ends it: a deliberate wait, and the buyer signs a new payment after
    `expirationLedger`. `…_spend_store_unavailable` and `…_facilitator_underfunded` are transient
    and in `UNSENT_REASONS`: they answer `retryable` and the identical payload reopens, as the
    other nothing-sent answers do. `…_payer_busy` recorded nothing, so it is retryable too, and
    `…_refused` (an error of ours) ends it.
36. **`recordSuccess` gives up after 500 ms** waiting for the scope row `reserve` holds, instead
    of holding a main-pool connection and starving `claim`. A dropped success only makes a wasm
    asset's breaker a little more eager. `recordFailure` keeps waiting.
37. **`reserve` rejects when its reservation row vanished** between the no-op insert and the
    state read (a prune between them), as "try again", instead of reserving against no budget.
    The policy retries a failed `reserve` every 200 ms until the settle deadline, then releases
    the id and refuses `…_spend_store_unavailable`.
38. **The busy wait reads its blocker directly**: a failed read counts as missing and the next
    claim decides, without `settlement_record_failed`, which is this record's outage alarm.
39. **`spend_scopes` is pruned** (`pruneScopes`, 0050's pruner, the reservations' horizon). This
    takes in 0097. *Narrowed by 42.*
40. **The nearing report**: at 80 % of any budget, at most once per scope in 15 minutes, with at
    most 10,000 scopes remembered (the oldest forgotten first, so it may report again).
41. **One `breakersOpen` query** reads the payer's, the `payTo`'s and (wasm) the asset's breaker
    together, where 19 made a read and a pool checkout each.

### From Karol's review of PR #105 (2026-11-04)

42. **`reserve` locks its scope rows in the insert itself** (`ON CONFLICT (scope) DO UPDATE`).
    `ON CONFLICT DO NOTHING` took no lock on a row that was there; `pruneScopes` counted a
    budget-only scope (`reserve` sets none of `window_start`, `last_opened_at`,
    `breaker_until`) as quiet however busy it was, so a prune between the insert and the
    `FOR UPDATE` left that select locking nothing, and two reserves could sum the window without
    each other: one ceiling over per race. The insert now locks or recreates each row, and
    `pruneScopes` also keeps a row with a reservation since its cutoff. A test that prunes right
    after the insert failed before the fix. `openBreaker`'s `GREATEST` went too: it only writes a
    closed breaker, whose end has passed, so the new end was always the later one.
43. **The payer's-frame rule stays ahead of the reused-nonce rule** (Karol asked for the reverse).
    A testnet probe (`scripts/front-run-probe.ts`, results in
    `scripts/results/front-run-testnet.json`) front-ran a `test-wallet` payer's payment in the test
    token and in a self-issued SAC: ours failed on chain with `Error(Auth, ExistingValue)` naming
    the token both times (`39f63dd4…9927`, `401016df…a0d0`), and `attribute` charged nobody. The
    host checks the nonce when the token calls `require_auth`, before `__check_auth` runs, so a
    front-run can't name the payer; in the payer's own frame the error can only come from the
    wallet's own nested auth, which is its fault. The threat model's residual line said otherwise
    and is corrected.
44. **A stale balance reading is logged.** Past `maxStaleMs` (10 intervals, at least 5 minutes,
    so 5 minutes at the default 30 s) the floor fails closed, so that long an RPC outage refuses
    every `/settle` as `…_facilitator_underfunded` with a funded account. That is kept: a fee
    account nobody can read may be draining. It now logs `facilitator_balance_stale` (error) once
    when it goes stale and `facilitator_balance_fresh` (info) when a read refreshes it; the
    README's limits table names the bound.

## Acceptance Criteria

- [x] Given a global rolling fee budget and per-payer, per-`payTo` and per-asset budgets, when the before-submit hook runs, then it reserves the fee against all of them; over any budget, `/settle` returns `success: false` and submits nothing
  - Reserved at the ceiling, all or none, narrowest budget named. The per-payer and per-`payTo`
    budgets are split by tier (25), and other tokens also share `tier:other`.
- [x] Given a settlement outcome, when it is final, then the reservation is settled at the fee actually paid or released
- [x] Given repeated on-chain failures for one asset or one `payTo`, when the threshold is reached, then that breaker opens and settlements for it are refused until it resets
  - Only failures attributed to that party count (23–25). A SAC asset never gets a refusing
    breaker, by design: its code is the host's. Wasm assets, payers and `payTo`s do. Story 2.3's
    criterion says so since 2026-11-04.
- [x] Given a budget nearing its limit or a breaker opening, when it happens, then an event is emitted for the alerts in 0027; state goes through `SpendStore`, and the numeric limits are in config and recorded in this task
  - Budgets are config; the breaker thresholds are code constants (`BREAKERS`), recorded above.
  - Testnet evidence: `apps/facilitator/scripts/results/spend-matrix-testnet.json` (a wasm token
    and a self-issued SAC), rerun on 2026-11-02 after the final-review fixes and the merge with
    develop: all ten checks pass. The USDC case was not run: it needs an account holding testnet
    USDC (`CLIENT_SECRET`). The matrix doesn't reopen a payment; 27 and 28 are held by the suite.

## Follow-ups

- [0097](../../backlog/0097_FEATURE_prune-spend-scopes.md): taken in by this task (39, 42); close
  it when #105 merges.
- On archiving this task: ADR 0007 (two links) and `m1-spine.md`'s AD-18 link into
  `lore/1-tasks/active/0024_…`; point them at `archive/` (Karol's review).
- [0098](../../backlog/0098_BUG_spend-review-minors.md): the minors left from the per-task and final
  reviews.
- M2, from decision 31: [0105](../../backlog/0105_FEATURE_api-keys-on-pubnet.md) (API keys on
  pubnet), [0106](../../backlog/0106_FEATURE_api-key-portal-discord.md) (the portal with Discord
  sign-in), [0107](../../backlog/0107_FEATURE_per-key-fee-quota.md) (free quota and per-key fee
  budget), [0108](../../backlog/0108_FEATURE_settle-billing.md) (charging past the quota).

## Modified tests

- `test/database.ts`: `empty` retries a deadlock. `onFinal` runs after a test's answer, so its late
  write can meet the `TRUNCATE`; the store's tables are locked in the opposite order. Test only.
- `test/drain-takeover.test.ts` (0073's): a funded fee account, the nonce in the simulation's
  footprint, which `/settle` now needs, and a nonce per case: it failed about one run in eight,
  most likely on the first case's late release, though that cause wasn't confirmed.
- `test/payment.ts`: `transferPayload` takes `nonce` as develop's fourth argument; `usedNonces` is
  shared by the two compose suites.
- `test/port-contracts.ts`: `settlement()` defaults `asset` to `CASSET${nonce}`, so records of
  one payer are in assets of their own and don't wait on each other in the single-flight slot
  unless a test gives one asset; `release` takes `now` (its row is kept as `released`). The breaker case
  "keeps the later end" became "leaves an open breaker as it is" (42).
- `test/postgres.test.ts`: `recordSuccess` gives up on a held scope row instead of waiting (36).
- `test/balance-floor.test.ts`: the floor is the 5 XLM default (decision 7).
- `test/settle-pool.test.ts`: generated nonces start at 1000, so a late `onFinal` of a generated
  key never meets a test's explicit `"8"`.
