---
id: "0009"
title: "Settle exact payments once through the channel pool"
type: FEATURE
status: active
milestone: 1
related_adr: ["0003", "0004", "0005", "0006", "0007", "0011"]
related_tasks: ["0007", "0006", "0012", "0015", "0016", "0017", "0018", "0019", "0020", "0024", "0025", "0027", "0014"]
tags: [facilitator, signer-pool, exact, settlement, priority-high, effort-medium, payments]
links:
  - ../archive/0007_FEATURE_facilitator-settlement-submitter.md
  - ../../../docs/x402-settlement-scaling-en.md
  - ../../../docs/architecture/m1-spine.md
  - ../../../docs/planning/m1-epics.md
history:
  - date: "2026-10-06"
    status: backlog
    who: claude
    note: "Spawned from 0007 future work and the PR #4 review (Adam)."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: >
      Re-scoped by the 0012 M1 architecture spine: T1 wiring for `exact`. The `upto` part moved
      to 0015; the signer-pool changes it needs are in 0016.
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: >
      Narrowed to M1 Story 1.4 (Payments lane) when 0012 split T1 into stories. Moved out:
      /verify and the fee config to 0018, the record lifecycle and startup check to 0019,
      /supported and the channel hardening check to 0020, spend budgets to 0024, the channel
      lease to 0025, alerts to 0027.
  - date: "2026-10-13"
    status: active
    who: okarcz
    note: >
      Work started, stacked on 0018 (PR #33) for the reusable verify checks and fee settings.
---

# Settle exact payments once through the channel pool

## Summary

As a resource server, I want `POST /settle` to settle a verified `exact` payment exactly once,
through the channel pool, so that I get a transaction hash for every paid request and a buyer is
never charged twice.

**Story:** [M1 Story 1.4](../../../docs/planning/m1-epics.md#story-14-settle-exact-payments-once-through-the-channel-pool) · **Lane:** Payments · **Covers:** FR2, FR6, FR9 (AD-2, AD-3, AD-6)

## Context

- Call the cataloging hooks by the caller rules in 0031's Design Decisions (header before the
  body; `onSuccess` after the response, `res.closed`-aware).
- 0007 built the pool and measured it on testnet: about 1 settlement per channel per ledger, up
  to the network ceiling.
- ADR 0003: one payment = one transaction through this pool, in the delegated-bump shape, with
  `settlement_pending` on timeout.
- The 0012 spine: upstream `@x402/stellar` verifies, we settle through the pool, and channel
  accounts count as "facilitator as source" (AD-4, ADR 0005).
- Builds on the skeleton and hooks (0017), the reusable verify checks (0018) and the signer-pool
  prerequisites (0016). Runs on the in-memory `SettlementStore` until 0022 lands.

## Implementation

- **Settle (AD-2, AD-3):** rerun the 0018 checks, build `{func, auth}` from the client's payload
  and submit with `SettlementSubmitter.submit()`, with the deadline from the signature expiry and
  `maxLedger` from the auth expiry. The pool's `checkSimulation` hook enforces the spec's
  balance-change check. Upstream `settle()` is never called.
- **Claim and dedupe (AD-6):**
  - Key `network:payer:nonce`; exactly one payer auth entry, otherwise reject.
  - Fingerprint: hash of the canonical payload plus `paymentRequirements`.
  - Atomic insert-if-absent claim before `submit()`.
  - Same fingerprint: return the stored outcome, waiting within the settle timeout if pending
    (the e2e resource server retries once, immediately). A success is answered once (decision 16).
  - Different fingerprint: `success: false`, nothing submitted.
- **Wire mapping (AD-6):** `pending` → `{success:false, errorReason:"settlement_pending", transaction, network}`, plus a fixed `errorReason` for each submitter error class.
- **Hooks:** call the before-submit hook (spend budgets, 0024) before `submit()` and the
  on-success hook (cataloging, 0031) when the record turns `success`.
- **From 0017 (reviews of PRs #7 and #11):**
  - Wrap `onSuccess` errors in the caller: log and count them, they never reach the client.
    `/settle` doesn't wait for `onFinal`, and its errors never reach the caller either
    (`apps/facilitator/src/settlement/hooks.ts`).
  - `SettlementStore.transition` only moves forward and refuses a same-state update, so exactly
    one of several concurrent callers wins (ADR 0006). Changing fields without moving the state
    would need its own store operation.
  - Decide with 0020 how facilitator tests get `FakeRpc`: it sits in
    `packages/signer-pool/test/` and isn't exported; a `./testing` subpath export is the
    suggestion.
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): `/settle` answers within its budget, now 30 s
  (decision 17), below the seller's own 90 s timeout and the ALB's 120 s.
  - Pass the pool a `deadline`, so the wait for a channel counts too.
  - When the budget runs out after the transaction was sent, answer `settlement_pending` with its
    hash (AD-6).
  - When nothing was sent, the record ends and the answer is `settle_exact_stellar_timeout`: the
    client signs a new payment (decision 11).

## Acceptance Criteria

- [x] Given a valid payload, when `/settle` is called, then it reruns the 1.3 checks, claims `network:payer:nonce`, submits `{func, auth}` through `SettlementSubmitter` with the deadline from the signature expiry and `maxLedger`, and returns `{success: true, transaction, network, payer}`; upstream `settle()` is never called and nothing else in the service calls `sendTransaction`
- [x] Given several concurrent `/settle` calls for one settlement key, when they run, then exactly one transaction is submitted
- [x] Given a repeat call with the same fingerprint, when `/settle` is called again, then it returns the stored outcome, waiting within the settle timeout if the record is pending; a success is answered once, later calls get `…_already_settled` with the hash (decision 16)
- [x] Given a repeat call with a different fingerprint, when `/settle` is called, then it returns `success: false`, submits nothing and never returns the stored outcome; a payload with zero or several payer auth entries is rejected
- [x] Given a submission that is still pending at the settle timeout, when `/settle` answers, then it returns `{success: false, errorReason: "settlement_pending", transaction, network}`; every `SubmitStatus` and submitter error class maps to a fixed `errorReason`, listed with the code
- [x] Given the hooks from 1.1, when a settlement runs, then the before-submit hook runs before `submit()` and the on-success hook runs when the record turns `success`
- [x] Given the fee configuration, when `main()` builds the pool, then it uses the same `fees.pool` that `buildVerifier` gets, so `/verify` and the pool share one ceiling and one bid (AD-10; deferred from 0018's AC 5). `main()` builds one `fees`, then `buildChecks` (for `/verify` and `/settle`) and the pool from it

**From 0018's PR #33 review (Adam), done after the rebase:**
- [x] the `/settle` expiry recheck uses the pool's floor of 2 ledgers, not `minValidityLedgers` (spine AD-22; decision 8);
- [x] `SettleResponse.payer` passes on only as a string, as in `/verify` (0018 decision 20; decision 9);
- [x] the `/settle` tests use an `accepted` that differs from the requirements;
- [x] define the answer for `FeeLimitError` and `LedgerBoundError` after `/verify` accepted (decision 10).

## Implementation Notes

- **`settlement/settle.ts`**: `createSettler()` returns `/settle`'s function.
  1. If the payload's settlement key (read from the transaction alone by `keyOf`) already has a record, the call is a repeat. Same fingerprint: the stored outcome, waiting up to `SETTLE_TIMEOUT_MS` while a signed record isn't final, or until the first call's budget for an unsigned one (decision 13); a success only once (decision 16). Other fingerprint: `settle_exact_stellar_nonce_already_used` with the stored hash, nothing submitted, the stored outcome never returned.
  2. Otherwise it runs the `/verify` checks (`createChecker` from 0018, which also checks the one payer auth entry and returns the parsed transaction, payer, nonce, auth expiry and current ledger).
  3. It claims `network:payer:nonce`. The fingerprint is the SHA-256 of the payload and requirements as canonical JSON.
  4. It runs `beforeSubmit`. A refusal, or a hook that throws, ends the record as `rejected` without `onFinal`.
  5. It submits the client's `{func, auth}`, with:
     - `onSigned` storing each hash (`addHash`) before it's sent;
     - `maxLedger` = the auth expiry;
     - `deadline` = the earlier of the settle budget and the auth expiry at 5 s a ledger;
     - `checkSimulation` = `expectTransfer`.
  6. It records the result with forward-only compare-and-set writes (`advance`). The writer that makes a record final runs `onFinal`.
- **`expectTransfer`**: the spec's balance-change check on the pool's own simulation. It requires exactly one `transfer` event from the asset contract, with the payment's from, to and amount, and no other contract event. It reads the events the way upstream `verify()` reads its own simulation's.
- **Fixed `errorReason`s**: `SETTLE_REASONS`, one per `SubmitStatus` and per submitter error class, plus the payer-auth, nonce-reuse, refusal and timeout cases. `failed` and `rejected` reuse upstream's settle codes.
- **Settle budget** (`SETTLE_BUDGET_MS`, default 30 s, at most 80 s, ADR 0011): when it runs out, the answer is `settlement_pending` with the hash if one was signed, or `settle_exact_stellar_timeout` if not, and nothing new is signed. A signed submission carries on. A late success runs `onFinal(record, "resolved")` and `onSuccess(record, "resolved")`.
- **`http/app.ts`**: `POST /settle` takes the same body check as `/verify`. It passes the settler an `AbortSignal` that fires when the client leaves before the answer. It sets the `EXTENSION-RESPONSES` header on the `success` answer, and calls `afterResponse` (`onSuccess(record, "settle")`) after the response, `res.closed`-aware (0031's caller rules). It logs one `settled` event with the settlement key and a `replay` flag.
- **`main.ts`**: `buildSettlement(config, deps)` builds the `SettlementSubmitter` from `fees.pool`, with `keypairSigner(FACILITATOR_SECRET)` and the channels, and the settler with `settleCheck(checks)` and the budget. The pool's events go to `pool_events_total` by type; `resolved` is also logged (0019). The hooks are `beforeSubmit` allow-all and `onFinal` no-op until 0024, plus the cataloger's `onSuccess`/`extensionResponses`. `main()` refuses `stellar:pubnet` with `STORE=memory`.
- **Rebased onto develop after 0018 merged** (2026-10-14). `main.ts` now has `buildChecks(config, rpc, fees)`, from which `createVerifier` (`/verify`) and `createChecker` (`/settle`) are built, and the pool takes the same `fees.pool`. `createChecker` keeps 0018's envelope check, upstream deadline and string `payer`, and throws when upstream names no payer for a valid payment, as 0018 does for `unexpected_verify_error`. Facilitator 145 tests after the rebase, and the testnet `scripts/settle-smoke.ts` passes all 5 checks again. Adam's four handoff points then took it to 148: the settle floor through `buildChecks`, the real-checker `payer` test, and the refusal warning; `accepted` now differs in `settle.test.ts` and `settle-route.test.ts`. Each fix's mutant (the `/verify` minimum at `/settle`, `accepted` passed as the requirements to the settler or used for the amount, no refusal metric) fails 1–24 tests.
- **PR #41 code review** (2026-10-14): 10 findings, each checked against the code. Five were real and are fixed (decisions 11–15). Two were not bugs: the success hash (the pool reports only envelopes it sends, rebuilds only after a `txBadSeq` that applied nothing, and its last attempt is `hash`) and a muxed `payTo` (upstream reads the event amount the same way, so `/verify` refuses it first). Three were skipped: the `settle-smoke.ts` port race (config refuses `PORT=0`, and it's a manual script), sharing `within` with `withTimeout` (they differ: one resolves `undefined`, one rejects with a named error), and `advance()`'s extra read before each write (left for 0022's durable stores). One helper now logs and counts hook failures for all three hooks. Facilitator tests 148 → 153; putting each bug back fails 1–5 of them. The testnet smoke run was not repeated.
- **PR #41 second review** (Adam, 2026-10-15, changes requested): 2 blockers reproduced on testnet, 1 before pubnet, 3 before 0022/0024, the `/verify`–`/settle` disagreement, 11 minor points and the test gaps. All are fixed here (decisions 16–28), with okarcz's choices for the two that needed one. `apps/facilitator/README.md` now lists every `/settle` answer with what an integrator should do. `@stellar-x402/signer-pool/testing` exports `FakeRpc`, and `settle-pool.test.ts` runs `main()`'s `/settle` wiring on the real pool. Facilitator tests 153 → 177, signer-pool 99. Mutants caught: `createChecker(checks)` at `/settle`, a pool without `fees.pool`, `budgetMs: settleTimeoutMs`, a settler that ignores `addHash`'s `false`, a fingerprint without the requirements, a no-op `checkSimulation`, `accepted.payTo` in the balance check, success on every replay (7 tests), a repeat anchored on its own start, no budget-over flag, `onFinal` for a writer that didn't end the record.
- **Nothing else sends**: `grep sendTransaction|.settle(` in `apps/facilitator/src` finds nothing; the pool is the only sender.
- **Tests**: facilitator 74 → 122.
  - `settle.test.ts` (37): memory store, a fake submitter, and real XDR payloads.
  - `settle-route.test.ts` (5).
  - Mutations caught: dropping the fingerprint check, allowing several payer entries, `onSuccess` on every success, dropping `maxLedger`, dropping the amount check, ignoring an uncertain send, and a deadline that ignores the auth expiry. The one survivor (`onFinal` without the final-state guard) is equivalent, since `finish` only receives final states.
- **Testnet** (`scripts/settle-smoke.ts`, friendbot keys, 2 fresh channels), all 5 checks passed:
  - a real XLM-SAC payment settled, `SUCCESS` on chain;
  - the same request again got the same hash;
  - the same payload with other requirements got `…_nonce_already_used`;
  - two concurrent calls for a new payment submitted one transaction;
  - `/verify` of the settled payment fails.
- **Testnet after the second review** (2026-10-15, same script, fresh friendbot keys and channels), all 5 checks passed: the payment settled (`841e647f…`, `SUCCESS` on chain); the same request again got `…_already_settled` with that hash; the same payload with other requirements got `…_nonce_already_used` with that hash; two concurrent calls for a new payment submitted one transaction (`52c7e746…`), one answered `success` and the other `…_already_settled`; `/verify` of the settled payment fails.

**Modified tests (second review):** `settle.test.ts`: concurrent calls, a repeat after the success and the known-key repeat now expect one success and `…_already_settled` for the rest; the payload's `accepted` also differs in asset and `payTo`; the stub check returns the nonce and rejects a payload without one payer entry, as `createChecker` now does; "answers a retryable timeout…" is now "ends the record and answers a timeout…" and also checks the retry; "never sends what it answered as timed out" asserts that the late `onSigned` rejects; the store-failure success expects the header record; the late success expects `onFinal(…, "resolved")`; the different-fingerprint test changes only the requirements and expects the hash. `config.test.ts`: 20 s / 30 s defaults, and the timer range case moves to `LEASE_TTL_MS`. `settle-route.test.ts`: the settler gets an `AbortSignal`, and the log a key. `port-contracts.ts`: two new store contract tests. `scripts/settle-smoke.ts` expects `…_already_settled` on the repeat and one success among the concurrent calls.

**Modified tests:** the budget test "answers a retryable timeout…" now also expects the record `rejected` with `…_timeout` and one `onFinal` (decision 11). `main.test.ts` no longer expects 501 from `/settle`. It and `verify-route.test.ts` pass `settle` and `extensionResponses` stubs to `start()`. `config.test.ts` expects `settleBudgetMs`. `settle.test.ts` and `settle-route.test.ts` give the payload an `accepted` whose amount differs from the requirements (Adam's point 3).

## Issues Encountered

- **A repeat failed the checks once the payment had landed.** The first testnet run showed it: the payment's nonce is used on chain, so upstream's simulation fails, and the retry after `settlement_pending` got `invalid_exact_stellar_payload_simulation_failed` instead of the stored outcome. Fix: a known key is answered from its record before any check (decision 1). A unit test now covers it.
- **Flaky test from time bounds.** Test transactions built with `setTimeout(60)` changed when a second ticked, so a repeat had another fingerprint and was correctly refused. The fixtures now use fixed time bounds.

## Design Decisions

### Emerged

1. **A repeat is answered from the record before the checks run.** ADR 0006's replay rule needs it (see Issues). The fingerprint still has to match exactly, so nothing new gets through. The checks run for every first call.
2. **A failure before anything was signed ends the record as `rejected`.** The same payload then gets the same failure, so the client retries by signing a new payment (new nonce). Examples: no channel in time, the simulation, the fee ceiling, a hook refusal. Reopening a record would need a store operation the port doesn't have.
3. **A thrown send that may have reached the network keeps the record open.** That's an attempt `sent: "unknown"`. The answer is `settlement_pending` with its hash, and 0019 resolves it.
4. **The balance-change check is ours** (`expectTransfer`), because upstream's event check is private and runs only on the client's simulation, not the pool's. It reads the events the same way.
5. **The settle module takes the pool as a `Submitter` interface,** so the settler's unit tests use a fake submitter. Amended by decision 27: `main()`'s wiring is now also tested on the real pool through `FakeRpc`.
6. **New fixed codes, named like upstream's:** `settle_exact_stellar_*` for settle-stage failures, plus `invalid_exact_stellar_payload_payer_auth_entries` and `…_nonce_already_used`.
7. **`SETTLE_BUDGET_MS`** is a config value, so the ADR 0011 budget can follow the load balancer's settings. Its default is now 30 s (decision 17).
8. **`/settle` rechecks the auth expiry at the pool's floor of 2 ledgers** (Adam, 0018's PR #33 review; spine AD-22). `settleCheck(checks)` in `main.ts` is `createChecker` with `SETTLE_MIN_VALIDITY_LEDGERS` = 2 in place of `MIN_VALIDITY_LEDGERS`. `/verify`'s larger minimum leaves room for the time between the two calls; rechecking with it refused, at `/settle`, payments the pool would still sign, after the resource was served.
9. **`/settle`'s `payer` is a string or absent,** with no settle-side code: every `payer` in a settle answer comes from `createChecker`, which drops a non-string one (0018 decision 20), or from the record, which stores the checked payer. A test runs a settle through the real `createChecker` with an upstream `payer` of 5.
10. **A fee or ledger refusal after `/verify` accepted keeps its answer and is flagged** (Adam, 0018's PR #33 review, asked to define it; to confirm in the 0009 PR). The answer stays `success: false` with `settle_exact_stellar_fee_exceeds_maximum` or `…_signature_expiration_too_soon`, the record ends `rejected`, nothing was sent, and the client needs a new payment (decision 2). It also means `/verify` and the pool disagreed: a new fee-stats reading or escalation raised the fee, or the call waited too long for a channel. So it logs `settlement_refused_after_verify` (warn) and counts `settle_refused_after_verify_total` by reason, for 0027's alerts.
11. **A timeout answer ends what it says was never signed** (PR #41 review). The pool checks `deadline` only while it waits for a channel, so a call that already had one could still sign and send after `/settle` answered `settle_exact_stellar_timeout`; the client would pay again with a new nonce. When the budget runs out, `outOfBudget` moves a `claimed` record (no hash) to `rejected` with `…_timeout`, by compare-and-set, and runs `onFinal`, since `beforeSubmit` had allowed it. `addHash` then refuses the record, so `onSigned` throws and the pool sends nothing. A record that already has a hash stays open, and the answer is `settlement_pending`. A same-payload retry now gets the timeout again rather than a late success; the client signs a new payment, as in decision 2.
12. **Nothing is submitted once the checks and `beforeSubmit` used up the budget** (PR #41 review). The record ends as in decision 11.
13. **A repeat waits for a record with no hash until the first call's budget ends, counted from the claim** (PR #41 reviews). It first waited `SETTLE_TIMEOUT_MS` and then its own budget; anchored on its own start, a repeat whose checks were slow could answer `…_timeout` before the first call signed (Adam, second review). Now it waits until `createdAt + SETTLE_BUDGET_MS` and then ends the record itself, by the same compare-and-set as decision 11, before it answers `…_timeout`. A record with a hash still waits `SETTLE_TIMEOUT_MS`.
14. **A refusal stands when the store can't record it** (PR #41 review). The failed write is logged (`settlement_record_failed`) and the hook's refusal is the answer, not a 500. The record stays `claimed` with no hash. A repeat once the budget is over ends it (decision 13) and gets `…_timeout` at once, not after a full wait: the hook's own reason is lost with the failed write, and either way the client signs a new payment. A thrown error before the claim, such as upstream verify failing, stays a 500, as the spine says (0018 decision 16).
15. **When the store fails after the pool answered, the answer is the pool's result** (PR #41 review). It used to be `unexpected_settle_error` with no hash, even for a payment that landed. Now a success is `success: true` with the pool's hash, and anything else is its fixed reason with the hash. A success carries the `EXTENSION-RESPONSES` header from the record as it would have been stored (0031 DD2, second review); there is no `markSuccessAnswered` and no `onSuccess` without a stored record. 0019 finishes the record. Likewise, a send that may have reached the network, followed by a store failure, is `settlement_pending` with that send's hash, not `unexpected_settle_error`.
16. **A success is answered once per record** (okarcz, 2026-10-15, Adam's proposal from the second review; AD-6 and ADR 0006 amended). Every same-fingerprint repeat used to get `success: true` and the header, so a seller delivered every request carrying one payment header (Adam: 4 × 200 for one charge on testnet). Now `markSuccessAnswered` (a new store compare-and-set on `successAnsweredAt`) lets one caller answer `success`; every later one gets `settle_exact_stellar_already_settled` with the hash and no header. `settlement_pending` doesn't count, so upstream's one retry after it still gets the success, and a call whose client left (the route's `AbortSignal`) marks nothing. The cost: a seller that lost our `success` answer can't get it again. If the mark can't be written, the answer is the success: the payment landed.
17. **`SETTLE_BUDGET_MS` 30 s and `SETTLE_TIMEOUT_MS` 20 s** (okarcz, 2026-10-15, Adam's numbers; ADR 0011 amended). The 90 s budget equalled `HTTPFacilitatorClient`'s 90 s timeout, whose timer starts before the request, so the seller always gave up first and our pending answer went to a closed socket (Adam: a 502 and a charged buyer on testnet). 30 s fits 97 % of the settlements 0043 measured (Adam's reading). Config now bounds the budget to 1–80 s and the timeout to at most the budget.
18. **`main()` refuses `stellar:pubnet` while `STORE=memory`** (second review). This PR makes `/settle` spend, with a store a restart loses, allow-all spend hooks, no rate limit and no lease. The check is in `main()`, not `parseConfig`, so the config tests can still parse a pubnet config; 0022 lifts it with a durable store.
19. **The one-payer-entry rule is a `/verify` check** (second review). Upstream de-duplicates signers and doesn't count entries, so `/verify` said valid for two payer entries and only `/settle` refused them: the seller served the request for free, as often as the signature lasted. `createChecker` now rejects them with `invalid_exact_stellar_payload_payer_auth_entries` and hands `/settle` the nonce.
20. **Every store and hook call is bounded, and the budget answer never throws** (second review). Before the claim, a store that doesn't answer within the budget is a 500, as a store error was. After it, `beforeSubmit` and the store calls are bounded by what is left of the budget, and the budget's own write, the success mark and each poll by `STORE_GRACE_MS` (1 s), so the longest call stays below the ALB's 120 s. `endUnsigned` never throws: when the store fails, the answer is what the call knows, `settlement_pending` with the last hash `onSigned` was given, or `…_timeout`. A budget-over flag makes `onSigned` refuse every new hash once the budget answer is out, so a `txBadSeq` rebuild can't land under a hash the answer didn't name. 0022's adapters still need their own timeouts.
21. **A `beforeSubmit` that doesn't answer within the budget ends the record as the budget does,** with `onFinal` (hooks.ts says so). If the hook later reserved spend, `onFinal` releases it; 0024's `onFinal` must accept a reservation that doesn't exist.
22. **Repeats share one store read per poll per key, and stop when their client leaves** (second review: 1,000 repeats held the event loop). One read is shared by every repeat of a key in each interval, and the route aborts a repeat whose client closed the connection.
23. **`RpcTimeoutError` before anything was signed answers `settle_exact_stellar_rpc_unavailable`** (second review). It used to be `unexpected_settle_error`, which reads as a bug. The record still ends, so the client signs a new payment, but it can tell "try later" from a bug.
24. **`…_nonce_already_used` carries the stored hash, if any** (second review: a front-run with only `extra` changed landed, and the real seller got `transaction: ""`). Never the outcome, never `success`.
25. **`/settle`'s own fee refusal is a drift too** (second review). Its re-check answers upstream's `invalid_exact_stellar_payload_fee_exceeds_maximum`, which is now logged and counted like the pool's refusals (decision 10); the set uses the `SETTLE_REASONS` constants.
26. **One origin per transition** (second review). A late success ran `onFinal(…, "settle")` and `onSuccess(…, "resolved")`. Now the call's origin turns `resolved` when its budget answer goes out, and both hooks get the origin of the write that finished the record.
27. **`FakeRpc` is exported as `@stellar-x402/signer-pool/testing`** (answers 0020's question; second review). `settle-pool.test.ts` runs `buildSettlement` on the real pool: a settlement, `/settle`'s floor of 2 ledgers, the pool's fee ceiling and the budget. The `attemptsOf` mock stays for the settler's unit tests: the real pool throws with a `sent: "unknown"` attempt only on paths `FakeRpc` can't reach (Adam: unreachable with the current pool).
28. **Metrics and logs for the rest** (second review): `settlement_uncertain_total`, `settlement_record_failures_total`, `settlement_submit_failures_total`, `settle_budget_exhausted_total` (by `signed`), `settle_already_settled_total` and `pool_events_total` (by type). `settled` carries the settlement key and a `replay` flag, and `settlement_hook_failed` the network and key. The store port says that `addHash` is atomic with `transition`, and the contract tests check it and `markSuccessAnswered`.

## Future Work

- **0019**: finish records from the pool's `resolved` events, now only logged (`settlement_resolved`), and resolve the records decision 3 leaves open.
- **0020**: the startup `checkChannel` and `/supported`. `FakeRpc` is exported as `@stellar-x402/signer-pool/testing` (decision 27).
- **0022**: the durable adapters implement `markSuccessAnswered` and an `addHash` atomic with `transition` (port doc, contract tests), with their own call timeouts; lift `main()`'s pubnet refusal (decision 18).
- **0024**: real `beforeSubmit` and `onFinal` (spend budgets), in place of the allow-all and no-op hooks in `main.ts`. `beforeSubmit` must answer within the budget, and `onFinal` may come for a reservation that was never made (decision 21).
- **0027**: alerts on the new counters (decision 28).
- **0025**: the channel lease before `/settle` is served.

