---
id: "0019"
title: "Settlement records survive restarts"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0006", "0011"]
related_tasks: ["0012", "0009", "0016", "0014"]
tags: [facilitator, settlement, priority-high, effort-medium, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.5 (Payments lane)."
  - date: "2026-10-08"
    status: backlog
    who: claude
    note: >
      Added the rule for claimed records with no hash at startup, from Stan's (stkrolikiewicz)
      PR #7 follow-up, with okarcz.
  - date: "2026-10-13"
    status: backlog
    who: okarcz
    note: >
      Added Adam's (adamkoot) attempt/settlement state model from the PR #22 review as an open
      question.
---

# Settlement records survive restarts

## Summary

As a facilitator operator, I want settlement records that are written before sending, only move forward, and are reconciled at startup, so that a crash or restart never loses a payment that may still land and never charges a buyer twice.

**Story:** [M1 Story 1.5](../../../docs/planning/m1-epics.md#story-15-settlement-records-survive-restarts) · **Lane:** Payments · **Covers:** FR10 (AD-16)

## Context

- A `resolved` event or the startup re-check that wins the `success` transition calls
  `onSuccess(record, "resolved")` (0031). The `success` transition sets `ledger`: the catalog
  orders its writes by it.
- 0009 claims and submits; this story makes the record durable and correct across restarts and late events.
- Needs the awaited `onSigned` from 0016.
- Related tasks: 0009, 0016.

## Implementation

- Settlement module in `settlement/` owning all `SettlementStore` writes, with forward-only compare-and-set.
- Multi-hash records and lookup by any hash.
- Startup reconciliation that runs before `/settle` is served (ADR 0011), while holding the
  channel lease (AD-17).
- **A `claimed` record with no hash at startup** (raised by Stan on PR #7): the process died
  between the claim and the first `onSigned`, for example while waiting for a channel or during
  simulation. The re-check has no hash to look up, and a retry with the same payload would find
  the stuck record forever. Since 0016 the pool sends only after `onSigned` succeeds, so no hash
  means nothing reached the network and the client's nonce is unused. Reconciliation closes it as
  `rejected` with `errorReason` "interrupted before signing", and the client can sign again.
  - It runs `onFinal`, unlike a `beforeSubmit` refusal: `beforeSubmit` may already have reserved
    spend budget, and only `onFinal` releases it. Releasing a reservation that doesn't exist does
    nothing (0024).
  - A live process that later tries to store a hash for the closed record gets `false` from
    `addHash`, which refuses final records, so it sends nothing.
- Tests with the in-memory store and `fake-rpc`, including a simulated crash between sign and send and one between the claim and the first
  `onSigned`.
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): reconciliation runs after the process takes the
  lease and before `/settle` is served.
  - The HTTP server listens at once, because ECS needs `/health` to answer.
  - Store each transaction's time bound next to its hash. After a crash the lease expires in 30 s,
    but the dead process's transactions stay valid for up to 60 s. A hash that isn't found stays
    non-final until its bound has passed.

## Acceptance Criteria

- [ ] Given a claimed settlement, when the pool signs its transaction, then the hash is written to `SettlementStore` through the awaited `onSigned` before the first send; if the write fails, nothing is sent
- [ ] Given a rebuild that produces a new hash, when it is signed, then the record keeps every hash and can be found by any of them
- [ ] Given a write that would move a record backwards, such as `pending` after `success`, when it arrives late, then the compare-and-set drops it; states only move `claimed → signed → pending → success | failed | rejected | expired`
- [ ] Given non-final records in the store, when the app starts, then before serving `/settle` it checks each one on chain by its hashes and finalizes it; a record that turns `success` this way fires the on-success hook
- [ ] Given a `claimed` record with no hashes at startup, when reconciliation runs while holding the lease, then it is closed as `rejected` with reason "interrupted before signing" and `onFinal` runs to release any spend reservation; nothing was sent, because 0016 sends only after `onSigned` succeeds
- [ ] Given any handler or event listener, when it needs to change a record, then it calls the single settlement module, which owns every write to `SettlementStore`

## Open Questions

- **Should the record keep attempt state apart from settlement state?** Raised by Adam on the
  [PR #22 review](https://github.com/rumblefishdev/stellar-x402/pull/22#pullrequestreview-5491880790).
  A hash given to `onSigned` is an attempt, not a send: after a `txBadSeq` rebuild the first
  envelope reached the network even if `submit()` then rejects, a bound can pass while the hook
  runs, and a timed-out write can commit after the channel reused the sequence. Since 0016,
  `SubmitResult.attempts` and `attemptsOf(error)` say for each hash whether it was sent (`yes`,
  `no` or `unknown`). His proposal, after card reversals (ISO 8583 0400), SEPA Inst status
  requests (pacs.028), Stripe's recovery points and CDP's `settlement_pending`:
  - Per hash: `stored` (`onSigned` resolved) → `sent` (`onSent`) → `landed` (`getTransaction`
    SUCCESS or FAILED), or `dead` (a send `ERROR` on a certain send, or NOT_FOUND once
    `latestLedger >= maxLedger` or the close time is past `maxTime`). The bounds are our reversal:
    past them an attempt provably can't land.
  - Per settlement, keeping AD-16's forward-only CAS: `signed` means at least one attempt is
    neither `landed` nor `dead`; `success`/`failed` come from the attempt that landed;
    `rejected`/`expired` only once every attempt is `dead`.
  - Never build a new attempt for a nonce while one is `stored` or `sent`: a retried `/settle`
    reconciles the existing attempts.
  - Startup reconciliation treats every `stored` attempt as possibly sent and resolves it by
    `getTransaction` plus the bounds.
