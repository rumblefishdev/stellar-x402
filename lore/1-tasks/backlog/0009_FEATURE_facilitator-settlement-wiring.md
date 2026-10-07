---
id: "0009"
title: "Settle exact payments once through the channel pool"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0003", "0004", "0005", "0006", "0007"]
related_tasks: ["0007", "0006", "0012", "0015", "0016", "0017", "0018", "0019", "0020", "0024", "0025", "0027"]
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
---

# Settle exact payments once through the channel pool

## Summary

As a resource server, I want `POST /settle` to settle a verified `exact` payment exactly once,
through the channel pool, so that I get a transaction hash for every paid request and a buyer is
never charged twice.

**Story:** [M1 Story 1.4](../../../docs/planning/m1-epics.md#story-14-settle-exact-payments-once-through-the-channel-pool) · **Lane:** Payments · **Covers:** FR2, FR6, FR9 (AD-2, AD-3, AD-6)

## Context

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

## Acceptance Criteria

- [ ] Given a valid payload, when `/settle` is called, then it reruns the 1.3 checks, claims `network:payer:nonce`, submits `{func, auth}` through `SettlementSubmitter` with the deadline from the signature expiry and `maxLedger`, and returns `{success: true, transaction, network, payer}`; upstream `settle()` is never called and nothing else in the service calls `sendTransaction`
- [ ] Given several concurrent `/settle` calls for one settlement key, when they run, then exactly one transaction is submitted
- [ ] Given a repeat call with the same fingerprint, when `/settle` is called again, then it returns the stored outcome, waiting within the settle timeout if the record is pending
- [ ] Given a repeat call with a different fingerprint, when `/settle` is called, then it returns `success: false`, submits nothing and never returns the stored outcome; a payload with zero or several payer auth entries is rejected
- [ ] Given a submission that is still pending at the settle timeout, when `/settle` answers, then it returns `{success: false, errorReason: "settlement_pending", transaction, network}`; every `SubmitStatus` and submitter error class maps to a fixed `errorReason`, listed with the code
- [ ] Given the hooks from 1.1, when a settlement runs, then the before-submit hook runs before `submit()` and the on-success hook runs when the record turns `success`
