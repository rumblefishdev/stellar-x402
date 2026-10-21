---
id: "0019"
title: "Settlement records survive restarts"
type: FEATURE
status: active
milestone: 1
related_adr: ["0006", "0011"]
related_tasks: ["0012", "0009", "0016", "0014", "0013"]
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
  - date: "2026-10-20"
    status: active
    who: okarcz
    note: "Started after 0009 (PR #41), as the next Payments task."
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
- From 0009 (PR #41 reviews; ADR 0006's store-outage rule): records an outage leaves
  unfinished are this task's to finish once the store is back:
  - a success answered from the pool's result while the store failed stays `signed` or
    `pending`; finishing it to `success` lets a later repeat win the mark and get a second success
    (0009 decision 29). Mark such a finish answered, e.g. `successAnsweredAt` set at the finish,
    but only if the success was sent: one the budget answer replaced (`settlement_pending`) never
    was, and a repeat must still get it (0009 decision 56). The process's `answeredHere` knows
    which; the store doesn't yet;
  - every `pending` answer waits for this task: until then a repeat gets `settlement_pending`
    for as long as the record stays `pending`. With `STORE=memory` a restart drops it; with
    `STORE=postgres` it survives restarts (the README says so).
- From 0009 (PR #41 reviews), moved here when 0022 and 0013 closed before PR #41 merged: what a
  durable, shared store adds, which the memory store can't show:
  - **clock skew** between instances on `unsignedUntil = existing.createdAt + SETTLE_BUDGET_MS`,
    which compares one instance's `createdAt` with another's clock (0009 decision 46);
  - **two settlers on one store** for the repeat paths (0009 decisions 29, 31): a repeat that
    can't end a record answers `settlement_pending`, and a success the store can't mark is
    answered once per process only;
  - **the `addHash` / budget race** (0009 decision 35): `onSigned` checks the budget flag again
    after `addHash`; keep that order, and test a slow `addHash`;
  - **a timeout per store call:** `/settle` bounds each one by its budget and a 1 s grace, but a
    hung driver call still holds a connection;
  - **Multi-AZ against decision 29's window:** a success the store couldn't mark can be answered
    twice across instances or after recovery until this task; say whether the store's failover
    (ADR 0012: Multi-AZ on mainnet) shortens that window;
  - **a typed `StoreUnavailableError` at the ports**, an option to verify: only if `/settle` needs
    to tell "busy" from a bug (today both are a 500 before the claim, or the store-outage rule
    after it).
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): reconciliation runs after the process takes the
  lease and before `/settle` is served.
  - The HTTP server listens at once, because ECS needs `/health` to answer.
  - Store each transaction's time bound next to its hash. After a crash the lease expires in 30 s,
    but the dead process's transactions stay valid for up to 60 s. A hash that isn't found stays
    non-final until its bound has passed.
- Option from 0022's third review, to verify rather than a decision (a better approach may exist): `settlement_hashes` holds only `(hash, key, seq)`, and `addHash` takes no time bound
  or per-hash status. Adding a nullable column later is cheap, and rows written before it can fall
  back to the auth expiry in `payment_payload`. If this task lands before the first durable deploy
  (0026), it can still edit `0001_init` instead.
- From 0022 (Karol's review of PR #30), to verify rather than a decision: the startup sweep closes
  every `claimed` record without a hash, whatever its age. With one lease holder per network that
  is right; with ADR 0011's option of two tasks on separate channel sets, one task's sweep would
  reject the other's live claims (money stays safe: `addHash` refuses a final record). Option:
  close only claims older than `createdAt + SETTLE_BUDGET_MS + margin`, the rule 0009's replay
  already uses, with a later pass for younger ones. A `claimed_by` column was rejected: a client
  repeat landing in the same process would look like its own claim and sign twice.

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
