---
id: "0009"
title: "Settle exact payments once through the channel pool"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0003", "0004", "0005", "0006", "0007", "0011"]
related_tasks: ["0007", "0006", "0012", "0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0022", "0023", "0024", "0025", "0026", "0027", "0031", "0043", "0045", "0047", "0049"]
tags: [facilitator, signer-pool, exact, settlement, priority-high, effort-medium, payments]
links:
  - ../../archive/0007_FEATURE_facilitator-settlement-submitter.md
  - ../../../../docs/x402-settlement-scaling-en.md
  - ../../../../docs/architecture/m1-spine.md
  - ../../../../docs/planning/m1-epics.md
  - notes/S-design-decisions.md
  - notes/R-pr41-reviews.md
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
  - date: "2026-10-16"
    status: active
    who: claude
    note: >
      Third PR #41 review (Adam) and @karolko9's points applied: decisions 29–45, facilitator
      177 → 205 tests, signer-pool 99 → 101. Converted to a directory with notes/.
  - date: "2026-10-16"
    status: active
    who: claude
    note: >
      Fourth PR #41 review (Adam): decision 46 (a repeat that lost the claim leaves an unsigned
      record to the first call), facilitator 205 → 207.
  - date: "2026-10-20"
    status: active
    who: claude
    note: >
      Stan's review (decision 47: RPC_URLS[i]#<fingerprint>, relative test-helper imports) and the
      rebase onto develop after 0022 (decision 48: PostgreSQL markSuccessAnswered, migration
      0002_success_answered). Facilitator 207 → 305 with 0022's PostgreSQL suite.
  - date: "2026-10-20"
    status: active
    who: claude
    note: >
      Sixth PR #41 review (Adam): decision 49 (the config refuses pubnet until 0023, 0024 and
      0025, folded into the commit that added main()'s check), the hand-offs lost with 0022 into
      0019 and 0023, the should-fix points and the nits (decisions 50–55). Facilitator 305 → 320,
      signer-pool 101 → 111.
  - date: "2026-10-21"
    status: active
    who: claude
    note: >
      Seventh PR #41 review (Adam, approved): decisions 56–59 (a fallback success counts as
      answered once sent, a depth cap of 256, an unexpected error after a send stays pending, bare
      RPC hosts named in logs); 0019's bullet, 0024's and 0049's. Facilitator 320 → 327.
  - date: "2026-10-21"
    status: completed
    who: okarcz
    note: >
      PR #41 merged into develop by rebase (ef10461), approved by Adam and Stan after seven review
      rounds; all acceptance criteria met. 59 design decisions; facilitator tests 103 → 327,
      signer-pool 99 → 111. Its open points are "From 0009" bullets in 0019, 0020, 0023–0027,
      0045 and 0049.
---

# Settle exact payments once through the channel pool

## Summary

As a resource server, I want `POST /settle` to settle a verified `exact` payment exactly once,
through the channel pool, so that I get a transaction hash for every paid request and a buyer is
never charged twice.

**Story:** [M1 Story 1.4](../../../../docs/planning/m1-epics.md#story-14-settle-exact-payments-once-through-the-channel-pool) · **Lane:** Payments · **Covers:** FR2, FR6, FR9 (AD-2, AD-3, AD-6)

## Context

- 0007 built the pool and measured it on testnet: about 1 settlement per channel per ledger, up
  to the network ceiling. ADR 0003: one payment = one transaction through this pool, in the
  delegated-bump shape, with `settlement_pending` on timeout.
- The 0012 spine: upstream `@x402/stellar` verifies, we settle through the pool, and channel
  accounts count as "facilitator as source" (AD-4, ADR 0005).
- Builds on the skeleton and hooks (0017), the reusable verify checks (0018) and the signer-pool
  prerequisites (0016). Runs on the in-memory `SettlementStore` or, since the rebase onto 0022, the PostgreSQL one (`STORE=postgres`). Calls the
  cataloging hooks by 0031's caller rules.

## Implementation

- **Settle (AD-2, AD-3):** a known key is answered from its record; a new payment reruns the
  0018 checks within the settle budget, then the pool submits the client's `{func, auth}` with a
  deadline of the budget or the auth expiry, whichever comes first, and `maxLedger` = the auth
  expiry. The pool's `checkSimulation` hook enforces the spec's balance-change check. Upstream
  `settle()` is never called.
- **Claim and dedupe (AD-6):** key `network:payer:nonce` (exactly one payer auth entry);
  fingerprint = hash of the canonical payload plus `paymentRequirements`; atomic
  insert-if-absent before `submit()`. Same fingerprint: answered from the record, waiting within
  `SETTLE_TIMEOUT_MS` while it is pending (the e2e resource server retries once, immediately),
  and a success only once. Different fingerprint: `…_nonce_already_used` with the stored hash,
  nothing submitted.
- **Wire mapping (AD-6):** `settlement_pending` with the hash, and a fixed `errorReason` for each
  submitter error class (`SETTLE_REASONS`), listed for integrators in `apps/facilitator/README.md`.
- **Hooks:** `beforeSubmit` (spend budgets, 0024) before `submit()`; `onFinal` once per final
  record; `onSuccess` (cataloging, 0031) after the response.
- **Budget (ADR 0011):** `SETTLE_BUDGET_MS` 30 s bounds the whole call, the checks and the wait for
  a channel included. Past it: `settlement_pending` with the hash if one was signed, otherwise the
  record ends and the answer is `…_timeout` (before the claim, nothing is recorded).

## Acceptance Criteria

- [x] Given a valid payload, when `/settle` is called, then it reruns the 1.3 checks, claims `network:payer:nonce`, submits `{func, auth}` through `SettlementSubmitter` with a deadline of the settle budget or the signature expiry, whichever comes first, and `maxLedger`, and returns `{success: true, transaction, network, payer}`; upstream `settle()` is never called and nothing else in the service calls `sendTransaction`
- [x] Given several concurrent `/settle` calls for one settlement key, when they run, then exactly one transaction is submitted
- [x] Given a repeat call with the same fingerprint, when `/settle` is called again, then it answers from the record, waiting within the settle timeout if the record is pending; a success is answered once, later calls get `…_already_settled` with the hash (decision 16)
- [x] Given a repeat call with a different fingerprint, when `/settle` is called, then it returns `success: false`, submits nothing and never returns the stored outcome; a payload with zero or several payer auth entries is rejected
- [x] Given a submission that is still pending when the settle budget runs out, when `/settle` answers, then it returns `{success: false, errorReason: "settlement_pending", transaction, network}`; every `SubmitStatus` and submitter error class maps to a fixed `errorReason`, listed with the code
- [x] Given the hooks from 1.1, when a settlement runs, then the before-submit hook runs before `submit()` and the on-success hook runs when the record turns `success`
- [x] Given the fee configuration, when `main()` builds the pool, then it uses the same `fees.pool` that the checks get, so `/verify` and the pool share one ceiling and one bid (AD-10; deferred from 0018's AC 5); `compose()` builds one `fees`, then `buildChecks` (for `/verify` and `/settle`) and the pool from it, tested in `settle-pool.test.ts`

**From 0018's PR #33 review (Adam), done after the rebase:**
- [x] the `/settle` expiry recheck uses the pool's floor of 2 ledgers, not `minValidityLedgers` (spine AD-22; decision 8);
- [x] `SettleResponse.payer` passes on only as a string, as in `/verify` (0018 decision 20; decision 9);
- [x] the `/settle` tests use an `accepted` that differs from the requirements;
- [x] define the answer for `FeeLimitError` and `LedgerBoundError` after `/verify` accepted (decision 10).

## Implementation Notes

- **`settlement/settle.ts`**: `createSettler()` returns `/settle`'s function.
  1. A payload whose key (`keyOf`, from the transaction alone) has a record is a repeat (`replay`): the fingerprint must match; it waits for a signed record up to `SETTLE_TIMEOUT_MS`, for an unsigned one up to the first call's budget and then ends it, both capped by its own budget (one that lost the claim may stop first, and then leaves the record, decision 46); a success only once.
  2. Otherwise the `/verify` checks (`createChecker`), bounded by the budget.
  3. The claim (`network:payer:nonce`, SHA-256 fingerprint of canonical JSON).
  4. `beforeSubmit`; a refusal, or a hook that throws, ends the record `rejected` without `onFinal`.
  5. The pool's `submit()` with `onSigned` (`addHash`, durable before the send), `maxLedger`, `deadline` and `checkSimulation` = `expectTransfer`.
  6. Forward-only compare-and-set writes (`advance`); the writer that makes a record final runs `onFinal`; `respond` marks a success answered (`markSuccessAnswered`, with a process-local set for store failures).
- **`settlement/verify.ts`**: `createChecker` also refuses auth entries without address credentials, and an auth expiry past ledger 2^32 − 2 (decision 53).
- **`http/app.ts`**: `POST /settle` takes the `/verify` body check (and a depth cap of 256, decision 57), an `AbortSignal` for a client that left, the `EXTENSION-RESPONSES` header on a success, `afterResponse` after the response (`res.closed`-aware), and one `settled` log with the key and a `replay` flag.
- **`main.ts`**: `compose(config, …)` builds, on the stores it is given (memory ones when absent), the cataloger, RPC, one `fees`, `buildChecks` and `buildSettlement` (the pool from `fees.pool`, `keypairSigner`, the channels; the settler with `settleCheck(checks)` and the budget); `main()` builds the PostgreSQL stores when `STORE=postgres` and starts it. The config refuses `stellar:pubnet` until 0023, 0024 and 0025 land (decision 49).
- **`signer-pool`**: `./testing` exports `FakeRpc`; `FallbackRpc` throws `RpcUnavailableError`; `submit()` refuses source-account auth (`SourceAccountAuthError`).
- **Nothing else sends**: `grep sendTransaction|.settle(` in `apps/facilitator/src` finds nothing.
- **Tests**: facilitator 103 → 327 (209 before the rebase onto 0022, whose PostgreSQL suite adds most of the rest) (`settle.test.ts` 82, `settle-route.test.ts` 10, `settle-pool.test.ts` 7), signer-pool 99 → 111. The review rounds, their mutants, modified tests and the testnet runs are in [notes/R-pr41-reviews.md](notes/R-pr41-reviews.md).

## Design Decisions

### Emerged

All 59, with their reasons, are in [notes/S-design-decisions.md](notes/S-design-decisions.md).
The ones a reviewer should check first: 1 (a repeat answered from the record), 11 and 13 (a
timeout answer ends what was never signed), 16 (a success once), 29 and 30 (okarcz: the store
outage), 45 (the #45 rebase), 46 (a repeat that lost the claim leaves the record to the first
call), 47 and 59 (RPC URLs and hosts in logs), 48 (PostgreSQL `markSuccessAnswered`), 49 (the
pubnet refusal), 53 (`/verify` refuses an expiry past 2^32 − 2), 56 (a fallback success counts as
answered once sent), 57 (the depth cap) and 58 (an unexpected error after a send stays pending).

## Future Work

Each item is also a "From 0009" bullet in its task:

- **#45 rebase** (0045, after this merges): `buildUpstream()` into `buildChecks`, `trace` on `Check`, `settle-pool.test.ts`'s positional `buildChecks`, a `/settle` test with a hung first RPC URL (decision 45); switch logs named by `rpcEndpointName` (decision 47).
- **0026**: where `RPC_URLS` lives on Hetzner, with its old values (decision 47).
- **0013** (closed before this merged): ADR 0012 answers the availability part (Single-AZ on testnet, Multi-AZ on mainnet, transactional writes); whether Multi-AZ failover shortens decision 29's window goes to 0019.
- **0019**: finish records from the pool's `resolved` events, now only logged; resolve the records decisions 3, 15 and 30 leave open; close the second-success exception (decision 29). From 0022's list, which closed before this merged: clock skew on `unsignedUntil` across instances, two settlers on one store for the repeat paths, a slow `addHash` against the budget (decision 35), and a timeout per store call.
- **0020**: the startup `checkChannel` and `/supported`.
- **0022** (closed before this merged): done in this PR's rebase (decision 48): PostgreSQL `markSuccessAnswered`, migration `0002_success_answered`, `addHash` atomic with `transition` (its row lock). Its config refuses `STORE=memory` outside testnet, so `main()`'s own refusal is gone (decision 18); the config refuses pubnet as a whole instead (decision 49). Its hand-over to 0009: a hash another settlement owns (`HashConflictError`) stops the send (`SignedHookError`), and the record ends `rejected` with `settle_exact_stellar_record_write_failed`; a NUL (`\u0000`) in a payload fails the claim as a store error, a 500 before money moves (→ 0023, validate it); `reserve` rejecting when the store is busy is 0024's.
- **0023**: lift the pubnet refusal with 0024 and 0025 (decision 49); memory store growth with no rate limit; reject a NUL (`\u0000`) or a lone UTF-16 surrogate in `/verify` and `/settle` bodies, which PostgreSQL refuses in `text` and `jsonb`.
- **0024**: real `beforeSubmit` and `onFinal`; lift the pubnet refusal with 0023 and 0025 (decision 49); parallel-spend fee griefing; a `__check_auth` that fails only on chain, and zero-amount transfers; `onFinal` after a late hook (decision 34); a reservation keyed by the settlement key, refused after its release (decision 46).
- **0025**: the channel lease before `/settle` is served; lift the pubnet refusal with 0023 and 0024, after confirming the lease belongs there (decision 49).
- **0027**: the metrics of decision 38, the outcome counter, alarms on store failures.
- **0049**: split `Attempt.sent: "yes"` into accepted and refused (decision 58).
