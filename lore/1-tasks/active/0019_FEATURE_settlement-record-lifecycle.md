---
id: "0019"
title: "Settlement records survive restarts"
type: FEATURE
status: active
milestone: 1
related_adr: ["0006", "0011"]
related_tasks: ["0012", "0009", "0016", "0014", "0013", "0039"]
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
  - The HTTP server listens at once, because the container healthcheck needs `/health` to answer
    (ADR 0011, revised in 0039).
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

- [x] Given a claimed settlement, when the pool signs its transaction, then the hash is written to `SettlementStore` through the awaited `onSigned` before the first send; if the write fails, nothing is sent
- [x] Given a rebuild that produces a new hash, when it is signed, then the record keeps every hash and can be found by any of them
- [x] Given a write that would move a record backwards, such as `pending` after `success`, when it arrives late, then the compare-and-set drops it; states only move `claimed → signed → pending → success | failed | rejected | expired`
- [x] Given non-final records in the store, when the app starts, then before serving `/settle` it checks each one on chain by its hashes and finalizes it; a record that turns `success` this way fires the on-success hook
- [x] Given a `claimed` record with no hashes at startup, when reconciliation runs while holding the lease, then it is closed as `rejected` with reason "interrupted before signing" and `onFinal` runs to release any spend reservation; nothing was sent, because 0016 sends only after `onSigned` succeeds (the reason is the code `settle_exact_stellar_interrupted`, decision 15; the lease comes with 0025)
- [x] Given any handler or event listener, when it needs to change a record, then it calls the single settlement module, which owns every write to `SettlementStore`
- [x] Given a signed hash, when the pool stores it, sends it and resolves it, then its attempt moves `stored → sent | unknown → landed | dead` with its time and ledger bounds, and reconciliation decides from the network, never from these states (decision 7)

## Open Questions

- ~~**Should the record keep attempt state apart from settlement state?**~~ Yes: Adam's model
  ([PR #22 review](https://github.com/rumblefishdev/stellar-x402/pull/22#pullrequestreview-5491880790)),
  decided as decision 7, with `unknown` for an uncertain send. His rule "never build a new attempt
  while one is `stored` or `sent`" already holds: a repeat replays the record and never submits.
  "`rejected`/`expired` only once every attempt is `dead`" is decision 5.

## Implementation Notes

- **signer-pool:** `onSigned(hash, bounds)`, `SignedBounds { maxTime, maxLedger? }` from the
  envelope (`submitter.ts`).
- **Store port and adapters:** migration `0003_settlement_attempts` (nullable `state`,
  `max_time`, `max_ledger`, `channel`, `error_code`, `updated_at` on `settlement_hashes`);
  `addHash(key, hash, updatedAt, bounds?)` writes `stored`; `attempts(key)`;
  `markAttempts(key, updates, updatedAt)` and `transition`'s `update.attempts`, forward-only per
  hash (`isAttemptForward`, `attemptRankSql` in `rules.ts`).
- **`settlement/records.ts`:** the record writes and hooks moved out of `createSettler`
  (`advance`, `finish`, `recordFailed`, `answeredHere`), plus `unmarked`, `storeFailed` /
  `onStoreFailure`, and `attemptUpdates(attempts, outcome)`.
- **`settle.ts`:** passes the bounds to `addHash`, wires `onSent` to `markAttempts(sent)` without
  waiting, writes each result's attempts with the record; new reason
  `settle_exact_stellar_interrupted`.
- **`settlement/reconcile.ts`:** `createReconciler` (`sweep(mode)`, `resolved(result)`) and
  `scheduleReconciliation` (startup with backoff, store-recovery sweep, 5-minute timer,
  `ready()`).
- **Wiring:** `buildSettlement` shares one `Records` between the settler and the reconciler, and
  sends the pool's `resolved` event to it; `start()` starts reconciliation after listening;
  `/settle` answers 503 `{error: "reconciling"}` with `Retry-After: 5` until it is ready.
- **Docs:** README (`…_interrupted`, reconciliation, the 503, `0003`), spine AD-16, ADR 0006
  (amended 2026-10-22), 0025 (start reconciliation after the lease) and 0027 (counters and logs).
- **Tests:** facilitator 327 → 368 (256 → 290 without PostgreSQL; with it also the 2
  two-settler tests and the 5 attempt contract cases on PostgreSQL); signer-pool 111 → 112. New files `reconcile.test.ts`
  (20), `records.test.ts` (4). Each new rule was checked against its mutant.
- **Modified tests:** `settle.test.ts`'s fake pool passes `BOUNDS` to `onSigned` (its type
  changed); `postgres.test.ts`'s two `main()` tests wait for `app.reconciled`, since the startup
  sweep opens a main-pool connection and `/settle` answers 503 until it ends. Intentional.

## Issues Encountered

- **A mutant that couldn't be caught:** closing a hashless claim from its listed state instead of
  `claimed` is equivalent (it is listed as `claimed`); the risky variant, closing from the current
  state, fails the race test.
- **The backoff test missed a fixed delay** at first; it now checks the doubled wait to the
  millisecond.

## Design Decisions

### From Plan

1. **A hash the chain doesn't know waits out its time bound** (okarcz, 2026-10-22). `NOT_FOUND`
   keeps the record non-final until the hash's `maxLedger` / `maxTime` has passed, then it turns
   `expired`; never `failed` on `NOT_FOUND` alone, since a transaction in flight can still land.
   Each hash's bound is stored next to it.
2. **Every `claimed` record with no hash is closed at startup** (okarcz, 2026-10-22): `rejected`
   with "interrupted before signing", and `onFinal` runs. Karol's age rule (close only claims
   older than `createdAt + SETTLE_BUDGET_MS + margin`) was considered; `addHash` refusing a final
   record keeps money safe without it.
3. **Reconciliation relies on compare-and-set now; the lease comes with 0025** (okarcz,
   2026-10-22). Every write is a CAS and decision 1 never ends a hash that can still land, so
   records stay correct without the lease. What the lease prevents, two processes using one
   channel's sequence numbers, is `/settle`'s problem; 0025 takes the lease at startup and runs
   reconciliation after it.
4. **`/settle` answers 503 until reconciliation has finished** (okarcz, 2026-10-22). The server
   listens at once so `/health` answers; if the store or the RPC is down at startup, the process
   retries with backoff and logs, without crashing.
5. **A record with several hashes expires only when every hash's bound has passed** (okarcz,
   2026-10-22). A hash that landed decides the record (`success` or `failed`); otherwise it stays
   non-final until none of its hashes can still land.
6. **The per-hash bound arrives in a new `0003` migration** (okarcz, 2026-10-22), as nullable
   columns, not by editing `0001_init`; rows written before it fall back to the auth-entry expiry
   in `payment_payload`.
7. **Every hash keeps its own attempt state** (okarcz, 2026-10-22, Adam's model): `stored` →
   `sent` | `unknown` → `landed` | `dead`, in `settlement_hashes` next to the bound. `stored`
   comes with `addHash`; `sent` from signer-pool's existing `onSent`, not awaited (the
   transaction is already out, so a failed write changes nothing); `unknown` (the send threw) and
   `landed` / `dead` from the pool's result (`SubmitResult.attempts`, `attemptsOf(error)`), in
   the same transaction as the record's update.
8. **Reconciliation also sweeps after a store failure, with a 5-minute timer as a safety net**
   (okarcz, 2026-10-22). Besides startup, a failed store write arms a sweep that runs once the
   store answers again (with backoff); every 5 minutes a sweep runs regardless. A fixed 60 s timer
   was considered: it queries when nothing failed, and alone decides how long a leftover waits.
9. **A success answered during a store outage is marked answered only when this process knows
   it sent it** (okarcz, 2026-10-22). A live process finishing such a record sets
   `successAnsweredAt` if the key is in `answeredHere`. After a restart that set is gone, so the
   record is finished unmarked: a repeat may get one more `success`, at most once (it wins the
   mark), and no money moves twice. Marking it was considered: a client that got
   `settlement_pending` would then get `already_settled`, paid and with nothing to show
   (0009 decisions 29, 56).
10. **Clock skew on `unsignedUntil` is accepted and documented** (okarcz, 2026-10-22). With one
    lease holder per network (0025) only a deploy overlap compares one instance's `createdAt` with
    another's clock; NTP keeps the skew far below the 30 s budget, so the cost is a
    `settlement_pending` slightly early or late. A margin and the database's clock were
    considered; the latter breaks the schema's rule that SQL never reads it.
11. **Two settlers on one Postgres store get their own tests** (okarcz, 2026-10-22): a parallel
    claim, a repeat while the first call runs, and a success marked once, with two settlers on
    one store; skipped without a database, like the other PostgreSQL tests.
12. **No `StoreUnavailableError`** (okarcz, 2026-10-22). `/settle` has nothing different to do on
    a busy store: before the claim it stays a 500, after it ADR 0006's outage rule applies, and
    decision 4's 503 covers startup.
13. **A live sweep closes a hashless `claimed` record only past its budget** (okarcz,
    2026-10-22): older than `createdAt + SETTLE_BUDGET_MS` plus a margin. Past the budget no call
    adds a hash (`onSigned` refuses), and `addHash` and `transition` are atomic, so no live payment
    fails. The startup sweep still closes every one (decision 2). Considered: leaving them to the
    next restart, and skipping only this process's in-flight keys (another instance's claims
    would be closed). Reconciliation still decides from `getTransaction` and the bound: `stored` and `sent`
   are hints, since a crash or an uncertain send can leave them behind the network. Considered:
   the bound only (no extra write, history in logs) and the bound plus a sent flag.

### Emerged

14. **Attempts are read with `attempts(key)`, not carried on `SettlementRecord`**: the proposed
    `attempts[]` beside `hashes` would have changed every record comparison; only reconciliation
    reads them.
15. **The interrupted claim's reason is a code, `settle_exact_stellar_interrupted`**, not the text
    "interrupted before signing": a repeat answers with the record's `errorReason`.
16. **`unmarked` tracks successes answered without the store's mark**, and each sweep retries
    their mark, also for a record already `success` (the mark failed, not the transition). Keys
    in flight in `respond` aren't in it, so a sweep never takes a live call's success.
17. **What a result says per hash** (`attemptUpdates`): every attempt before the last was refused
    with `txBadSeq` (the only rebuild); a last attempt never sent is `dead`; after an unexpected
    error an accepted one stays `sent`.
18. **Attempt facts are written even when the record's write loses**: `transition` applies
    `update.attempts` whether or not the state moves, and `advance` writes them to a final record.
19. **The pool's `resolved` event goes through the reconciler** (`findByHash`), and a failure
    there arms a store-recovery sweep.
20. **Defaults:** live-sweep margin 5 s, 4 records at a time, `Retry-After: 5`, backoff 1–30 s.
    No partial index on open attempts: they are read by key, which `settlement_hashes_key` covers.
21. **`/settle` opens once the startup sweep has tried every record** (okarcz, 2026-10-22), not
    once each has been checked. A record the RPC or the store couldn't check is retried at once
    in the background, with backoff, until it is. Meanwhile a repeat of it answers
    `settlement_pending` with its hash, which is true, and new payments have their own keys.
    Waiting for every record (as first built) let one record that keeps failing close `/settle`
    for everyone, and a 2-minute cap still blocked every payment for it. In both, a transaction
    the dead process sent may still land on a channel a new payment reads its sequence from (ADR
    0011's 60 s): one of the two gets `txBadSeq`, and no money moves twice.
