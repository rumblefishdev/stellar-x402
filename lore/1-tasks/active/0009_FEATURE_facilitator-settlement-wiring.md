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
- From 0022 (PR #30, merged): `SettlementStore.addHash` rejects a hash another settlement owns with
  `HashConflictError`; map it to an aborted send. Validate `\u0000` in payloads and resources
  (PostgreSQL rejects a NUL in text and jsonb). `SpendStore.reserve` can reject when the store is
  busy or unreachable (`55P03`, no pool connection in 5 s, a lost `COMMIT` answer): answer 503 with
  a retry, not 500; a retry with the same `id` is safe. Options to verify, not decisions: a typed
  `StoreUnavailableError` if `/settle` needs to tell "busy" from a bug; reject lone UTF-16
  surrogates (`isWellFormed()`), which jsonb rejects; `claim` only after `/verify` fully passes, or
  throwaway payers leave unpruned payloads.

## Acceptance Criteria

- [x] Given a valid payload, when `/settle` is called, then it reruns the 1.3 checks, claims `network:payer:nonce`, submits `{func, auth}` through `SettlementSubmitter` with the deadline from the signature expiry and `maxLedger`, and returns `{success: true, transaction, network, payer}`; upstream `settle()` is never called and nothing else in the service calls `sendTransaction`
- [x] Given several concurrent `/settle` calls for one settlement key, when they run, then exactly one transaction is submitted
- [x] Given a repeat call with the same fingerprint, when `/settle` is called again, then it returns the stored outcome, waiting within the settle timeout if the record is pending
- [x] Given a repeat call with a different fingerprint, when `/settle` is called, then it returns `success: false`, submits nothing and never returns the stored outcome; a payload with zero or several payer auth entries is rejected
- [x] Given a submission that is still pending at the settle timeout, when `/settle` answers, then it returns `{success: false, errorReason: "settlement_pending", transaction, network}`; every `SubmitStatus` and submitter error class maps to a fixed `errorReason`, listed with the code
- [x] Given the hooks from 1.1, when a settlement runs, then the before-submit hook runs before `submit()` and the on-success hook runs when the record turns `success`
- [x] Given the fee configuration, when `main()` builds the pool, then it uses the same `fees.pool` that `buildVerifier` gets, so `/verify` and the pool share one ceiling and one bid (AD-10; deferred from 0018's AC 5). `main()` builds one `fees`, then `buildChecks` (for `/verify` and `/settle`) and the pool from it

**From 0018's PR #33 review (Adam), still to do after the rebase:**
- the `/settle` expiry recheck uses the pool's floor of 2 ledgers, not `minValidityLedgers` (spine AD-22);
- `SettleResponse.payer` passes on only as a string, as in `/verify` (0018 decision 20);
- the `/settle` tests use an `accepted` that differs from the requirements;
- define the answer for `FeeLimitError` and `LedgerBoundError` after `/verify` accepted.

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
- **Rebased onto develop after 0018 merged** (2026-10-14). `main.ts` now has `buildChecks(config, rpc, fees)`, from which `createVerifier` (`/verify`) and `createChecker` (`/settle`) are built, and the pool takes the same `fees.pool`. `createChecker` keeps 0018's envelope check, upstream deadline and string `payer`, and throws when upstream names no payer for a valid payment, as 0018 does for `unexpected_verify_error`. Facilitator 145 tests after the rebase, and the testnet `scripts/settle-smoke.ts` passes all 5 checks again.
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

**Modified tests:** `main.test.ts` no longer expects 501 from `/settle`. It and `verify-route.test.ts` pass `settle` and `extensionResponses` stubs to `start()`. `config.test.ts` expects `settleBudgetMs`.

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

## Future Work

- **0019**: finish records from the pool's `resolved` events, now only logged (`settlement_resolved`), and resolve the records decision 3 leaves open.
- **0020**: the startup `checkChannel` and `/supported`. No `FakeRpc` export is needed for 0009 (decision 5).
- **0024**: real `beforeSubmit` and `onFinal` (spend budgets), in place of the allow-all and no-op hooks in `main.ts`.
- **0025**: the channel lease before `/settle` is served.

