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
    (the e2e resource server retries once, immediately).
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
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): `/settle` answers within a 90 s budget, below the
  ALB's 120 s idle timeout and 100 s deregistration delay.
  - Pass the pool a `deadline`, so the wait for a channel counts too.
  - When the budget runs out after the transaction was sent, answer `settlement_pending` with its
    hash (AD-6).
  - When nothing was sent, answer with a failure the resource server can retry.

## Acceptance Criteria

- [x] Given a valid payload, when `/settle` is called, then it reruns the 1.3 checks, claims `network:payer:nonce`, submits `{func, auth}` through `SettlementSubmitter` with the deadline from the signature expiry and `maxLedger`, and returns `{success: true, transaction, network, payer}`; upstream `settle()` is never called and nothing else in the service calls `sendTransaction`
- [x] Given several concurrent `/settle` calls for one settlement key, when they run, then exactly one transaction is submitted
- [x] Given a repeat call with the same fingerprint, when `/settle` is called again, then it returns the stored outcome, waiting within the settle timeout if the record is pending
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
  1. If the payload's settlement key (read from the transaction alone by `keyOf`) already has a record, the call is a repeat. Same fingerprint: the stored outcome, waiting up to `SETTLE_TIMEOUT_MS` while it isn't final. Other fingerprint: `settle_exact_stellar_nonce_already_used`, nothing submitted, the stored outcome never returned.
  2. Otherwise it runs the `/verify` checks (`createChecker` from 0018, which also returns the parsed transaction, payer, auth expiry and current ledger), and requires exactly one payer auth entry.
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
- **Settle budget** (`SETTLE_BUDGET_MS`, default 90 s, ADR 0011): when it runs out, the answer is `settlement_pending` with the hash if one was signed, or `settle_exact_stellar_timeout` if not. The submission carries on. A late success runs `onFinal`, and `onSuccess(record, "resolved")`.
- **`http/app.ts`**: `POST /settle` takes the same body check as `/verify`. It sets the `EXTENSION-RESPONSES` header on every `success` answer, replays included, and calls `afterResponse` (`onSuccess(record, "settle")`) after the response, `res.closed`-aware (0031's caller rules). It logs one `settled` event.
- **`main.ts`**: builds the `SettlementSubmitter` from `fees.pool`, with `keypairSigner(FACILITATOR_SECRET)` and the channels. The hooks are `beforeSubmit` allow-all and `onFinal` no-op until 0024, plus the cataloger's `onSuccess`/`extensionResponses`. The pool's `resolved` events are only logged (0019).
- **Rebased onto develop after 0018 merged** (2026-10-14). `main.ts` now has `buildChecks(config, rpc, fees)`, from which `createVerifier` (`/verify`) and `createChecker` (`/settle`) are built, and the pool takes the same `fees.pool`. `createChecker` keeps 0018's envelope check, upstream deadline and string `payer`, and throws when upstream names no payer for a valid payment, as 0018 does for `unexpected_verify_error`. Facilitator 145 tests after the rebase, and the testnet `scripts/settle-smoke.ts` passes all 5 checks again. Adam's four handoff points then took it to 148: the settle floor through `buildChecks`, the real-checker `payer` test, and the refusal warning; `accepted` now differs in `settle.test.ts` and `settle-route.test.ts`. Each fix's mutant (the `/verify` minimum at `/settle`, `accepted` passed as the requirements to the settler or used for the amount, no refusal metric) fails 1–24 tests.
- **PR #41 code review** (2026-10-14): 10 findings, each checked against the code. Five were real and are fixed (decisions 11–15). Two were not bugs: the success hash (the pool reports only envelopes it sends, rebuilds only after a `txBadSeq` that applied nothing, and its last attempt is `hash`) and a muxed `payTo` (upstream reads the event amount the same way, so `/verify` refuses it first). Three were skipped: the `settle-smoke.ts` port race (config refuses `PORT=0`, and it's a manual script), sharing `within` with `withTimeout` (they differ: one resolves `undefined`, one rejects with a named error), and `advance()`'s extra read before each write (left for 0022's durable stores). One helper now logs and counts hook failures for all three hooks. Facilitator tests 148 → 153; putting each bug back fails 1–5 of them. The testnet smoke run was not repeated.
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
5. **The settle module takes the pool as a `Submitter` interface,** so the facilitator tests use a fake submitter and need no `FakeRpc` (answers 0020's question for 0009). The real pool is exercised by `scripts/settle-smoke.ts`.
6. **New fixed codes, named like upstream's:** `settle_exact_stellar_*` for settle-stage failures, plus `invalid_exact_stellar_payload_payer_auth_entries` and `…_nonce_already_used`.
7. **`SETTLE_BUDGET_MS`** (default 90 s) is a config value, so the ADR 0011 budget can follow the load balancer's settings.
8. **`/settle` rechecks the auth expiry at the pool's floor of 2 ledgers** (Adam, 0018's PR #33 review; spine AD-22). `settleCheck(checks)` in `main.ts` is `createChecker` with `SETTLE_MIN_VALIDITY_LEDGERS` = 2 in place of `MIN_VALIDITY_LEDGERS`. `/verify`'s larger minimum leaves room for the time between the two calls; rechecking with it refused, at `/settle`, payments the pool would still sign, after the resource was served.
9. **`/settle`'s `payer` is a string or absent,** with no settle-side code: every `payer` in a settle answer comes from `createChecker`, which drops a non-string one (0018 decision 20), or from the record, which stores the checked payer. A test runs a settle through the real `createChecker` with an upstream `payer` of 5.
10. **A fee or ledger refusal after `/verify` accepted keeps its answer and is flagged** (Adam, 0018's PR #33 review, asked to define it; to confirm in the 0009 PR). The answer stays `success: false` with `settle_exact_stellar_fee_exceeds_maximum` or `…_signature_expiration_too_soon`, the record ends `rejected`, nothing was sent, and the client needs a new payment (decision 2). It also means `/verify` and the pool disagreed: a new fee-stats reading or escalation raised the fee, or the call waited too long for a channel. So it logs `settlement_refused_after_verify` (warn) and counts `settle_refused_after_verify_total` by reason, for 0027's alerts.
11. **A timeout answer ends what it says was never signed** (PR #41 review). The pool checks `deadline` only while it waits for a channel, so a call that already had one could still sign and send after `/settle` answered `settle_exact_stellar_timeout`; the client would pay again with a new nonce. When the budget runs out, `outOfBudget` moves a `claimed` record (no hash) to `rejected` with `…_timeout`, by compare-and-set, and runs `onFinal`, since `beforeSubmit` had allowed it. `addHash` then refuses the record, so `onSigned` throws and the pool sends nothing. A record that already has a hash stays open, and the answer is `settlement_pending`. A same-payload retry now gets the timeout again rather than a late success; the client signs a new payment, as in decision 2.
12. **Nothing is submitted once the checks and `beforeSubmit` used up the budget** (PR #41 review). The record ends as in decision 11.
13. **A repeat waits for a record with no hash up to its own budget** (PR #41 review). It used to wait `SETTLE_TIMEOUT_MS` (30 s) and then answer `…_timeout` while the first call, with up to 90 s, could still sign. By the end of the repeat's budget, the first call's budget has ended the record (decision 11) or it has a hash. A record with a hash still waits `SETTLE_TIMEOUT_MS`.
14. **A refusal stands when the store can't record it** (PR #41 review). The failed write is logged (`settlement_record_failed`) and the hook's refusal is the answer, not a 500. The record stays `claimed` with no hash, so a repeat gets `…_timeout` after its budget. A thrown error before the claim, such as upstream verify failing, stays a 500, as the spine says (0018 decision 16).
15. **When the store fails after the pool answered, the answer is the pool's result** (PR #41 review). It used to be `unexpected_settle_error` with no hash, even for a payment that landed. Now a success is `success: true` with the pool's hash, and anything else is its fixed reason with the hash. No `EXTENSION-RESPONSES` header or `onSuccess` without a stored record; 0019 finishes the record.

## Future Work

- **0019**: finish records from the pool's `resolved` events, now only logged (`settlement_resolved`), and resolve the records decision 3 leaves open.
- **0020**: the startup `checkChannel` and `/supported`. No `FakeRpc` export is needed for 0009 (decision 5).
- **0024**: real `beforeSubmit` and `onFinal` (spend budgets), in place of the allow-all and no-op hooks in `main.ts`.
- **0025**: the channel lease before `/settle` is served.

