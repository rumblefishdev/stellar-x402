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
  - date: "2026-10-26"
    status: active
    who: okarcz
    note: >
      Applied Karol's (karolko9) PR #57 review: a record version guards expiry, one sweep loop
      replaces the scheduling and the 503 gate, and two outage leftovers are fixed (decisions
      26-30). Point 7 spawned 0070.
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
    hung driver call still holds a connection; *answered:* the PostgreSQL pools already set
    `statement_timeout` 10 s and `query_timeout` 15 s, so a sweep's store call ends too;
  - **Multi-AZ against decision 29's window:** a success the store couldn't mark can be answered
    twice across instances or after recovery until this task; say whether the store's failover
    (ADR 0012: Multi-AZ on mainnet) shortens that window; *answered:* it doesn't, since a failover
    is an outage like any other; decision 9 closes the window instead, once the store is back;
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
- [x] Given non-final records in the store, when the app starts, then reconciliation checks each one on chain by its hashes, from the first sweep at start and every 10 s after, beside `/settle`, and finalizes those the network has decided; one it couldn't check is tried again by the next sweep (decision 27, which replaced "before serving `/settle`"); a record that turns `success` this way fires the on-success hook
- [x] Given a `claimed` record with no hashes past its settle budget plus a margin, when reconciliation runs, then it is closed as `rejected` with reason "interrupted before signing" and `onFinal` runs to release any spend reservation; nothing was sent, because 0016 sends only after `onSigned` succeeds (the reason is the code `settle_exact_stellar_interrupted`, decision 15; reconciliation doesn't need the lease, decision 37)
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
- **Code review fixes** (decisions 22–25): after the rebase onto develop with 0045, facilitator
  409 → 418 with PostgreSQL: `reconcile.test.ts` +5 (history window, live budget guard, mark
  failure, retry cap, close during startup), `settle-pool.test.ts` +2 (the pool's `resolved`
  event through `buildSettlement`), `settle.test.ts` +2 (a settler and a reconciler sharing
  `records`; a crash between signing and sending). Each new rule was checked against its mutant.
- **PR #57 review (2026-10-26, decisions 26-31):** migration `0003` adds `settlements.version`;
  `transition(…, expectedVersion?)` in the port and both adapters; `records.advance` / `finish`
  pass it, and `records.finalWrite` / `unconfirmed` keep a final write that threw.
  `reconcile.ts`: `sweep()` without modes, `runLostHooks`, per-key `try` in `retryMarks`, the
  history-gone recheck; `scheduleReconciliation` is a 10 s loop with `start`, `close` and
  `reconciled`. `records.storeFailed` / `onStoreFailure`, `Reconciliation.ready()` and the 503
  branch are gone. Tests: facilitator 447 → 453 with PostgreSQL: contract +2 (version, `addHash`
  racing a versioned `transition`, on both adapters), `reconcile.test.ts` +3 net (rebuild during a
  sweep, lost hooks twice, one bad key; the scheduler tests rewritten for the loop, the
  one-sweep-at-a-time test removed), `settle.test.ts` +1 (a success answered once while a sweep
  stores it). Each fix was checked against its mutant.
- **Modified tests in the review round:** the hashless-claim tests advance the clock past the
  budget (decision 27 dropped "close all at startup"); the history-gone test waits 5 minutes for
  its recheck; `settle.test.ts` expects `transition`'s fourth argument and no longer listens for
  store failures; `settle-route.test.ts`'s 503 test now checks that `/settle` serves while the
  first sweep runs. Intentional.
- **Modified tests:** `settle.test.ts`'s fake pool passes `BOUNDS` to `onSigned` (its type
  changed); `postgres.test.ts`'s two `main()` tests wait for `app.reconciled`, since the startup
  sweep opens a main-pool connection and `/settle` answers 503 until it ends. Intentional.

## Issues Encountered

- **A mutant that couldn't be caught:** closing a hashless claim from its listed state instead of
  `claimed` is equivalent (it is listed as `claimed`); the risky variant, closing from the current
  state, fails the race test.
- **The backoff test missed a fixed delay** at first; it now checks the doubled wait to the
  millisecond. (The backoff went with decision 27.)
- **Karol's PR #57 review (2026-10-26)** found six races and outage leftovers the tests missed:
  the expiry time rule read after the RPC calls (1) and missing at startup (2), a fallback success
  answered twice (3), `pending` for up to 5 minutes after a restart (4), lost hooks after a write
  that committed and threw (5), a dropped store failure and one key stopping every sweep (6).
  Fixed by decisions 26-29.
- **Rebases onto develop:** `main.ts` (0020's channel check comment) and `app.ts` (0023's rate
  limiter on `/settle`) conflicted; the 503 test needed `CLIENT_IP` after 0023 made it required.

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
   *Replaced by decision 27 (2026-10-26):* every sweep closes a hashless claim only past its budget plus the margin, also the first after a start.
3. **Replaced by decision 37.** ~~Reconciliation relies on compare-and-set now; the lease comes with 0025~~ (okarcz,
   2026-10-22). Every write is a CAS and decision 1 never ends a hash that can still land, so
   records stay correct without the lease. What the lease prevents, two processes using one
   channel's sequence numbers, is `/settle`'s problem; 0025 takes the lease at startup and runs
   reconciliation after it.
   *Replaced by decision 37 (2026-10-27):* reconciliation doesn't wait for the lease.
4. **`/settle` answers 503 until reconciliation has finished** (okarcz, 2026-10-22). The server
   listens at once so `/health` answers; if the store or the RPC is down at startup, the process
   retries with backoff and logs, without crashing.
   *Replaced by decision 27 (2026-10-26):* `/settle` serves at once, beside the sweeps.
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
   the same transaction as the record's update. Reconciliation still decides from
   `getTransaction` and the bound: `stored` and `sent` are hints, since a crash or an uncertain
   send can leave them behind the network. Considered: the bound only (no extra write, history in
   logs) and the bound plus a sent flag.
8. **Reconciliation also sweeps after a store failure, with a 5-minute timer as a safety net**
   (okarcz, 2026-10-22). Besides startup, a failed store write arms a sweep that runs once the
   store answers again (with backoff); every 5 minutes a sweep runs regardless. A fixed 60 s timer
   was considered: it queries when nothing failed, and alone decides how long a leftover waits.
   *Replaced by decision 27 (2026-10-26):* one sweep every 10 s instead of the store-failure trigger and the 5-minute timer.
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
    would be closed).

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
    in the background, with backoff, until it is (at most 5 sweeps since decision 24). Meanwhile a repeat of it answers
    `settlement_pending` with its hash, which is true, and new payments have their own keys.
    Waiting for every record (as first built) let one record that keeps failing close `/settle`
    for everyone, and a 2-minute cap still blocked every payment for it. In both, a transaction
    the dead process sent may still land on a channel a new payment reads its sequence from (ADR
    0011's 60 s): one of the two gets `txBadSeq`, and no money moves twice.
    *Replaced by decision 27 (2026-10-26):* no gate.
22. **`NOT_FOUND` proves nothing before the RPC's history** (okarcz, 2026-10-22, from the code
    review). RPC keeps a window of ledgers (testnet keeps 120960, about 7 days; providers differ). A hash past its
    bound turns `dead` only when the RPC's oldest ledger closed at or before the record's claim;
    otherwise the record stays open and is logged once per process as `settlement_history_gone`
    (`settlement_history_gone_total`), for an operator to check its hashes. Considered: the same
    without the alarm (the record can sit unnoticed), and deferring it (a long outage could
    expire payments that landed, after the buyer paid).
23. **A live sweep doesn't expire a record inside its call's budget** (okarcz, 2026-10-22, from
    the code review): not before `createdAt + SETTLE_BUDGET_MS` plus the margin, the rule of
    decision 13. A sweep reads the hashes once; a `txBadSeq` rebuild stored after that read, near
    the first hash's time bound, could land on a record the sweep had just expired. Past the
    budget no call stores a hash. Dead hashes are written anyway. Considered: requiring no
    non-final hash in the store's compare-and-set (a port change in both adapters), and both.
    *Replaced by decision 26 (2026-10-26):* the time rule was checked after the RPC calls, and not at all at startup.
24. **The retry after a store failure or an unchecked record stops after 5 sweeps** (okarcz,
    2026-10-22, from the code review), logging `reconcile_gave_up`; the 5-minute sweep tries again.
    Each try re-checks every open record, so one record the RPC keeps failing on cost about one
    RPC call per open hash every 30 s, indefinitely. Considered: retrying only the failed keys
    (least load, a second retry path) and keeping it as built.
    *Replaced by decision 27 (2026-10-26):* no retries apart from the loop; a record whose RPC history is gone is checked every 5 minutes.
25. **Code review fixes that needed no decision** (2026-10-22):
    - `onSuccess` runs even when the answered mark fails: the record is final, so no sweep
      returns to it;
    - a sweep asked for during one runs after it (calls during one share it), so a store failure
      during a sweep isn't answered by that sweep's report;
    - a failed `sent` hint logs `settlement_attempt_mark_failed` at warn level: not a record
      failure, so no outage alarm and no sweep (decision 7: it changes nothing);
    - nothing starts once `close()` ran, also when the startup sweep ends after it; `close()`
      still doesn't wait for a sweep under way (0025's drain);
    - `isFinalRecord` stays next to `rules.ts`'s `isFinal`: `settlement/` doesn't import
      `adapters/`.

26. **A record version guards its expiry** (okarcz, 2026-10-26, from Karol's PR #57 review,
    point 1-2). `addHash` adds one to `settlements.version` (in `0003`, `NOT NULL DEFAULT 0`), and
    the sweep's `expired` write passes the version the record was listed with, read before
    `attempts()`. A hash stored since, such as a `txBadSeq` rebuild while the sweep waited for the
    RPC, makes the write fail, and the next sweep checks that hash. Decision 23's time rule was
    read after the RPC calls and didn't run at startup, so a deploy overlap could expire a payment
    that then landed. It needs no clock and no lease. A release before `0003` doesn't bump the
    version, but its hashes have no bounds, so all expire with the auth entry together.
    Considered: fixing the time rule (smallest, still clock-bound), and an "every hash dead"
    condition in the write (no column, a special SQL condition).
27. **One sweep every 10 s, beside `/settle`** (okarcz, 2026-10-26, Karol's point 4, 6, 8). The
    startup sweep with backoff, the store-failure trigger, the 5-minute timer, the 5-sweep cap
    and the 503 gate go: after a restart a landed payment answered `settlement_pending` for up to
    5 minutes, and a store failure during a retry sweep was dropped. A sweep starts at once and
    then 10 s after each one ends, so they never overlap; one that fails is logged
    (`reconcile_failed`) and followed by the next. Sweeps have no modes: a hashless claim closes
    past its budget plus 5 s in every sweep, so a new process doesn't close an old one's in-flight
    claim. `/settle` serves at once: a repeat of a leftover gets the same outcome without the gate
    (one with a hash waits and sees the sweep finish it; a hashless one past its budget is ended
    by the repeat, `…_timeout`), and a new payment isn't refused for the first sweep. A record
    whose RPC history is gone (decision 22) is checked every 5 minutes, not every tick.
    `reconcile_finished` is logged only for a sweep that changed or failed something. Considered:
    patching the scheduling (re-sweep while records are open, a rerun flag), and keeping the gate
    tied to the loop's first sweep.
28. **Replaced by decision 32.** ~~A fallback success holds its key from the moment it is built~~ (okarcz, 2026-10-26,
    Karol's point 3). When the store fails to record a success, the key goes into `answeredHere`
    before the call reads the record back, so a sweep that stores the success meanwhile doesn't let
    a repeat answer it too; the key goes into `unmarked` once the answer is sent, and out of both
    if it isn't (the client left, or the budget answer replaced it). If a repeat in this process is
    already answering it, the call answers `…_already_settled` with the hash.
29. **Hooks of a final write that threw run from the next sweep** (okarcz, 2026-10-26, Karol's
    point 5, 6). `records.finalWrite` keeps the key of a write to a final state that threw
    (`unconfirmed`); it may have committed, and then no sweep lists the record. Each sweep reads
    those keys: a final record gets `onFinal` (and `onSuccess` for a success); one that isn't stays
    until the writer that finishes it, which takes the key out, so the hooks run once in this
    process. A restart forgets the keys, and another process finishing the record during a deploy
    can make the hooks run twice: 0024's `onFinal` must tolerate a repeat. `retryMarks` and this
    pass take one key at a time, so one that keeps failing doesn't stop the sweep. Considered: a
    stored "hooks ran" flag (survives restarts, another column and query).

### Emerged (PR #57 review)

30. **`markAttempts` keeps its count** (2026-10-26). Point 9 suggested dropping it, unused in
    `src`; the store contract tests need it to show that exactly one of concurrent updates moved
    an attempt. Every other point-9 cleanup is done: the reconciler's options are constants, and
    the RPC history comment says testnet keeps 120960 ledgers (about 7 days).
31. **Point 7 is a backlog task, 0070** (okarcz, 2026-10-26): `expired` and `…_interrupted`
    tell the payer to sign again while the auth entry they signed may stay valid for minutes.

### Emerged (PR #57 second review)

32. **The store decides a fallback success** (okarcz, 2026-10-27, Karol's blocker; replaces
    decision 28). When the success write fails, the call reads the record back first. A success
    the store holds (the write committed after all, or a sweep stored it) goes through `respond`,
    whose mark gives it to one caller; the fallback from the pool's result is used only when the
    read-back fails or shows no success, and its key goes into `answeredHere` and `unmarked` only
    when that answer is sent. Decision 28 held the key from before the read-back, so a read-back
    past the budget left the key held: upstream's one retry on `…_pending` got
    `…_already_settled` and nobody was answered success. Left open: a read-back that returns just
    before a sweep stores the success still answers the fallback, and a repeat can then answer it
    too; closing that needs the store, which is what failed. No separate bound on the read-back:
    the call's budget answer covers one that hangs.
33. **A record already answered is answered `…_already_settled` without a mark** (okarcz,
    2026-10-27, Karol). `respond` checks `successAnsweredAt` first, so a repeat whose mark fails on
    a blip doesn't answer the success again (a gap since 0009).
34. **Only a failed write makes a key unconfirmed** (okarcz, 2026-10-27, Karol's non-blocking
    point). `advance` puts only its `transition` through `finalWrite`; a read that fails before it
    wrote nothing, so the next sweep doesn't run the hooks again.
35. **A writer takes its key out of `unconfirmed` while it writes** (okarcz, 2026-10-27, Karol's
    test C2). `finalWrite` removes the key when the write starts and puts it back if the write
    throws, or if it loses to another writer and the key was listed, so the sweep doesn't run the
    hooks beside a writer in this process. Considered: a separate set of writes in flight.

### Emerged (PR #57 hosting review)

36. **Reconciliation reports `listed` for the deploy** (okarcz, 2026-10-27, Stan's review).
    With `ready` meaning the lease (decision 27), the deploy's wait no longer tested the new
    image's reconciliation: an image whose `listNonFinal` always throws would pass and become
    the good digest. `Reconciliation.listed()` turns true once a sweep has listed the records,
    before it checks them, and stays true; `reconciled` can't serve, since it also settles after
    a sweep that threw. `/health` reports it beside `ready` (0026), and the deploy waits for both
    (ADR 0011). A sweep that starts failing later is 0027's alarm. Considered: folding it into
    `ready`, which `/settle`'s 503 also reads.
37. **Reconciliation doesn't depend on the lease** (okarcz, 2026-10-27, Stan's review; replaces
    decision 3). It sweeps in every process from the moment the server listens. It sends nothing
    and every write is a compare-and-set on the version (decision 26), so it needs no lease.
    After a crash the new process finishes a payment that landed at once, instead of after the
    dead process's lease expires (up to 30 s). Two live processes sweeping at once only repeat
    chain lookups, and one of their writes loses. 0025 drops its `held()` check on sweeps when it
    rebases. Considered: sweeping only while holding the lease, which avoids the duplicate
    lookups in a rare deploy overlap.

## Future Work

- **0070**: answer "sign a new payment" only once the payer's auth entry can no longer land.
