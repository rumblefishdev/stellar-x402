---
id: "0073"
title: "Tell the payer to sign again only once their auth entry can't land"
type: FEATURE
status: active
milestone: 1
related_adr: ["0006"]
related_tasks: ["0019", "0009"]
tags: [facilitator, settlement, priority-high, effort-medium, payments]
links:
  - ../../archive/0019_FEATURE_settlement-record-lifecycle.md
history:
  - date: "2026-10-26"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0019 (decision 31): point 7 of Karol's (karolko9) PR #57 review, left out of
      that PR.
  - date: "2026-10-27"
    status: backlog
    who: okarcz
    note: "Renumbered from 0070, which Karol's catalog badge task also took."
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Raised to high: until it is fixed, a payer told to sign again can pay twice.
  - date: "2026-10-28"
    status: active
    who: okarcz
    note: "Work started."
  - date: "2026-10-28"
    status: active
    who: okarcz
    note: >
      Converted to a directory for research notes: R-sign-again-prior-art (the x402 spec, upstream
      facilitators, Soroban auth, Stripe) and S-sign-again-rule (options; decision still open).
  - date: "2026-10-28"
    status: active
    who: okarcz
    note: >
      Rule decided (decisions 1-5; 6-10 came with the build): a cap of about 5 minutes on the
      auth entry's life at /verify, the envelope lives as long as the auth entry, an unsent
      payment may be retried as is until its auth entry expires (its closed record reopens), and
      a test shows a deploy's 180 s grace with a 5-minute envelope still ends every transaction
      through reconciliation.
---

# Tell the payer to sign again only once their auth entry can't land

## Summary

Some `/settle` answers tell the payer to sign a new payment while the authorization entry they
already signed is still valid. Anyone who holds that payload could still land it, and the payer
would pay twice. Decide when such an answer is safe, and change it if needed.

## Context

- The answers that mean "sign a new payment": `settle_exact_stellar_transaction_expired`
  (reconciliation, once every hash is past its envelope bound), `settle_exact_stellar_interrupted`
  (a claim closed before signing) and the older `…_timeout` ones.
- The envelope's time bound is 60 s (signer-pool `timeoutSeconds`). The payer's auth entry stays
  valid until its own `signatureExpirationLedger`, which the client sets and which can be
  minutes later.
- Until then, whoever holds the payment payload can build a new envelope around the same auth
  entry: the seller's resource server, or anyone who saw the request. If the payer has re-signed
  with a new nonce meanwhile, both can land.
- 0019 decision 6 already reads the auth entry's expiry (`authExpiration`) as the fallback bound
  of a hash stored without one.

## Research

- [R-sign-again-prior-art](notes/R-sign-again-prior-art.md): no spec, upstream facilitator or
  Coinbase doc tells a payer to sign again while the old payment can still land; upstream Stellar's
  envelope lives `maxTimeoutSeconds`, ours 60 s; a Soroban auth entry can't be revoked.
- [S-sign-again-rule](notes/S-sign-again-rule.md): our answers in two groups (nothing sent / sent
  and past the envelope bound), five options (the fifth, a cap on the auth entry's life, came
  from okarcz's 7-day attack), and the code checks behind them.

## Implementation

- **Cap** (decisions 2, 6): `/verify`, and `/settle`'s re-check, refuse an auth entry whose
  `signatureExpirationLedger` is more than `MAX_VALIDITY_LEDGERS` (default 66) ahead, with
  `invalid_exact_stellar_signature_expiration_too_far` and a message naming the cap.
- **Envelope** (decision 1): when the call sets `maxLedger`, the envelope's time bound no longer
  ends it early: drop it, or set it past the ledger bound. The confirm wait follows the ledger
  bound, so a transaction that never shows up holds its channel up to the cap, not 60 s.
  Reconciliation's `expired` then fires only once the auth entry can't land.
- **Retry of an unsent payment** (decision 3): a record closed with nothing sent (`timeout`,
  `rpcUnavailable`, `interrupted`, `shuttingDown`, `noChannelInTime`, `noChannels`) can be claimed
  again by the identical payload (same fingerprint) while its auth entry is valid. Those answers
  say "retry the same payment" until the expiration ledger, and "sign a new payment" only after
  it. Look at upstream's `…_submission_retryable` with `extra.retryable` for the answer's shape.
  The record reopens (decision 5): `claim()` moves a `rejected` record with no hash and the same
  fingerprint back to `claimed` in one compare-and-set, only while its auth entry is valid. A
  different payload on the same nonce stays refused. Amend AD-16 for this one backward edge, and
  keep the earlier answer in a log line or an attempt count.
- **Drain** (decision 4): keep 0025's fallback. Test it: a transaction sent just before SIGTERM,
  with a 5-minute envelope, outlives the 180 s grace; the next process takes the lease and its
  reconciliation ends the record with the transaction's real outcome.
- Update the facilitator README's settle answers, ADR 0006 (answers) and spine AD-22 (the cap and
  the envelope bound).

## Acceptance Criteria

- [x] Given an auth entry that expires more than 66 ledgers ahead (decision 6), when `/verify` or `/settle` checks it, then it is refused with `…_signature_expiration_too_far`, whatever `maxTimeoutSeconds` says
- [x] Given a sent transaction, when its envelope is built, then it can land until the auth entry's expiration ledger and no earlier bound ends it; reconciliation answers `…_transaction_expired` only once that ledger has passed
- [x] Given a payment closed with nothing sent, when the identical payload comes back while its auth entry is valid, then it is settled once; after the expiration ledger the answer is "sign a new payment"; a different payload on the same nonce is still refused
- [x] Given a transaction sent just before SIGTERM with a 5-minute envelope, when the 180 s grace ends before it is final, then the next process takes the lease and its reconciliation ends the record with the transaction's real outcome (test)
- [ ] Given the decided rule, when the task ends, then the decision and the options considered are recorded in this task (decisions 1-20 so far, S-sign-again-rule)

## Design Decisions

### From Plan

1. **The envelope lives as long as the auth entry** (okarcz, 2026-10-28): `expired` must mean
   "can no longer land", as the x402 family rule puts it. The 60 s time bound made `expired`
   unsafe for up to `maxTimeoutSeconds` minus 60 s. Chosen over keeping 60 s with a pending
   record, a cap alone, and accepting the risk.
2. **A cap of about 5 minutes on the auth entry's life** (66 ledgers by default, decision 6) (okarcz, 2026-10-28): without it,
   decision 1 lets a caller who writes both payload and requirements sign for days, and every
   dropped transaction would hold its channel that long. 300 s fits the main mainnet seller
   (0043). No facilitator found caps this; client-side clamps of 300 s exist.
3. **An unsent payment is retried as is, not re-signed, while its auth entry is valid**
   (okarcz, 2026-10-28): the payload stays landable by whoever holds it, so "sign a new payment"
   invites a double payment. Matches upstream EVM and SVM, Coinbase's guidance and Stripe's rule.
   Chosen over accepting the risk and over keeping the record open until expiry.
4. **The deploy keeps its 180 s grace** (okarcz, 2026-10-28): 0025's fallback (cut connections
   past 150 s, let the lease expire, the next process reconciles) covers a 5-minute envelope; a
   test must show it.
5. **An unsent record reopens on retry, rather than staying open** (okarcz, 2026-10-28): it
   closes at once and releases its spend reservation, and the identical retry reopens it
   (`rejected → claimed`, compare-and-set, before the auth expiry) and reserves again. So an
   abandoned payment holds no budget: in an outage, 200 open records would hold 200 USDC for up
   to 5 minutes. Cost: AD-16's forward-only states get one written exception. Chosen over a
   non-final `unsent` state closed by a sweep after the expiry.
6. **The cap is 66 ledgers by default** (okarcz, 2026-10-28; reasons amended 2026-10-29, PR 1
   review 2): upstream's client signs `ceil(maxTimeoutSeconds / t)` ledgers, with `t` the Horizon
   average rounded up to whole seconds (`Math.ceil`), so a 300 s resource signs 60 ledgers at
   5 s, 50 at 6 s and 75 at 4 s, never 63 as first written. Upstream's own check allows 2 more
   than that, so at 5 s at most 62 reach the cap; the rest is spare, and the cap only bites from
   about 330 s, or on a day of 4 s ledgers. Chosen over a strict 60 and over a lower 62.
7. **Build order: cap, envelope, reopen, drain test, as stacked PRs** (okarcz, 2026-10-28): the
   envelope must never ship before the cap, or a deploy between the two opens the 7-day attack.
   Each PR is safe on its own. The limit is documented in the README, not published in
   `/supported`.
8. **The refusal advises a `maxTimeoutSeconds` whenever the resource asked more than the advised
   limit** (okarcz, 2026-10-28, PR 1 review D1; amended 2026-10-29, PR 1 review 2): 300 s at the
   default, the cap less a tenth at 5 s a ledger. Since decision 22 that limit is a refusal of
   its own, so the advice is its message, which states the 5 s it assumes; the gap's refusal no
   longer gives a hint.
9. **A lagging RPC is an accepted risk** (okarcz, 2026-10-28, PR 1 review D2; amended
   2026-10-29, PR 1 review 2): both checks compare with our RPC's latest ledger. Upstream's own
   expiry check refuses first, at 3 or more ledgers behind the client's RPC and for any
   `maxTimeoutSeconds`, so the risk is its `+2` tolerance, not the cap, which would need 7 behind
   at 5 s. Rare (about 15 s behind); recorded in AD-22. Chosen over a wider default (72) and a
   separate lag margin.
10. **`MAX_VALIDITY_LEDGERS` is at most 120** (okarcz, 2026-10-28, PR 1 review D3): about 10
    minutes, so a typo can't reopen days-long signatures and the drain re-check in PR 2 has a
    known worst case. Chosen over a bound tied to the drain and over none.
11. **The time bound is dropped, not pushed past the ledger bound** (okarcz, 2026-10-28, PR 2;
    amended 2026-10-29, PR 2 review): with `maxLedger` set the envelope has `maxTime` 0, and
    `expired` is decided by the ledger bound alone, so it always means "can't land", however
    slow the ledgers. The pool's waits still end at the bound's estimated time, 6 s a ledger:
    `submit()`'s `pending` answer, a queued call's wait, the `onSigned` watcher and the
    TRY_AGAIN_LATER resends. So on slower ledgers an envelope the network kept refusing stops
    being resent with ledgers left and ends `expired` at its bound: a true answer, a payment
    that lost its last chances. The stop also keeps a down RPC from holding the loop. Chosen over
    a time bound of ledgers left × 10 s, and in review over resending until the ledger bound
    (its own interval and an "RPC down" check: a new mechanism).
12. **The drain test covers both outcomes across a deploy** (okarcz, 2026-10-28, PR 2): the
    transaction never lands (the next process ends it `expired` after the ledger bound), and it
    lands while no process holds the lease (`success`).
13. **A reopen runs the full `/settle` check first** (okarcz, 2026-10-28, PR 3): a record that is
    `rejected`, has no hash, has an unsent reason and the same fingerprint skips `replay()`, runs
    the check a first payment runs (simulation, fee, expiry against the latest ledger), then
    `store.reopen()` moves it to `claimed` in one compare-and-set. The happy path is unchanged;
    the cost is one simulation on a rare path. Chosen over an expiry-only check (a payment that
    went bad since would reopen and fail later in the pool) and a stored expiry column.
14. **A reopen count on the record, plus a log line** (okarcz, 2026-10-28, PR 3): a `reopened`
    column counts the reopens, and `settlement_reopened` logs the earlier `errorReason`. Chosen
    over a log line only and a history table.
15. **The same reason, marked retryable** (okarcz, 2026-10-28, PR 3): an unsent record keeps its
    reason; while its auth entry is valid the answer adds `extra.retryable: true` and the
    expiration ledger, with "retry the same payment until ledger N"; after it, "sign a new
    payment". Chosen over a new `…_submission_retryable` reason and a message-only change.
16. **The spend release race is left to 0024** (okarcz, 2026-10-28, PR 3): an earlier rejection's
    late `onFinal` release could delete a reopened call's reservation if both use the settlement
    key as its id. Nothing reserves yet, so 0024 gets the constraint (an id per claim, e.g. key
    plus the reopen count) and PR 3 passes the count to the hooks. Chosen over changing the hook
    contract now and accepting the race.
17. **One ledger left: wait, then sign again** (okarcz, 2026-10-28, PR 3 review D1): the auth
    entry is valid in its expiration ledger, so at one ledger left our pool can't use it but the
    holder can still land it. Three answers: 2 or more left, `retryable: true` (it reopens); 1
    left, `retryable: false` with "may still land in ledger N: once it has closed, sign a new
    payment"; none left, "sign a new payment". The message names the last ledger a repeat can
    still reopen. Chosen over `retryable: true` until the expiry and accepting a ~5 s window.
18. **An unreadable ledger stays retryable, and the client stops at the expiry** (okarcz,
    2026-10-28, PR 3 review D2): repeating the same payment is always safe, so the answer keeps
    `retryable: true`, and the message and README tell the client to stop once the network is
    past `expirationLedger`, then sign a new payment. Chosen over estimating the ledger from the
    clock (a wrong estimate could say "sign again" too early) and over `settlement_pending`.
19. **A generation guard on the reopened claim** (okarcz, 2026-10-28, PR 3 review D3): `reopen()`
    adds one to `version`; the repeat's `endUnsigned` and the sweep's `interrupted` close pass
    the version they read; and a call's `addHash` stores only on the claim it made (its
    `reopened` count). So a waiting repeat, a sweep or, across a lease handover, the first call
    can't write onto the new claim. Chosen over guarding only the closes and over documenting
    the risk. (Amended 2026-10-29, PR 3 review: the first call's other writes weren't guarded
    until decision 24.)
20. **Other answers that end a payment are out of this task's scope** (okarcz, 2026-10-28, PR 3
    review D4): refusals after the claim (simulation, fee, spend, `…_record_write_failed`,
    `unexpected_settle_error`), the re-check's refusal on a reopen, and an unsent reason with an
    earlier hash still say "sign a new payment" while the old auth entry may land. The task's
    Context lists the six "nothing sent" answers; the rest go to a backlog task that adds
    `expirationLedger` and "sign again after ledger N" to every answer that ended a payment
    that didn't land. Chosen over extending PR 3 and over accepting the risk.
21. **Only the payer's auth entry, no other address's** (okarcz, 2026-10-29, PR 1 review 2, Adam's
    blocker): the expiry checks read the earliest address-credential entry, so an extra signed
    entry from another account, valid for 60 ledgers, let the payer's own entry pass the cap while
    it stayed landable for days, and #86's answers would then say "sign a new payment" too early.
    Upstream accepts such an entry. The payload is now refused with
    `…_payer_auth_entries` ("exactly one auth entry: the payer's"), so the earliest expiry is the
    payer's everywhere. Chosen over reading the payer's expiry for the cap and the answers while
    keeping the earliest for `maxLedger` (two expiries across three PRs), and over a new reason
    code.
22. **A resource asking for more than the cap fits is refused on its `maxTimeoutSeconds`**
    (okarcz, 2026-10-29, PR 1 review 2): the gap the cap measures shrinks as ledgers close, so a
    payment P1 refused with `…_too_far` would pass a few ledgers later as it is, after the seller
    may have had its payer sign P2: both land. The requirements don't change over time, so a
    retry as it is stays refused. A sender who edits `maxTimeoutSeconds` gets through, but holds
    P1 and could submit it on chain without us anyway. Left open: a 300 s payment signed at 4 s
    ledgers (75) is refused by the gap and can pass later. Chosen over storing the refusal under
    the payment's key (`/verify` writing records, about a day of work and its own review) and
    over accepting the risk in writing.
23. **The same replay after `invalid_…_fee_exceeds_maximum` goes to 0086** (okarcz, 2026-10-29,
    PR 1 review 2): on develop already, and decision 22 can't close it, since a fee isn't in the
    requirements. Chosen over fixing it in this PR with stored refusals.
24. **Every write of a call is guarded by its claim, in the store's statement** (okarcz,
    2026-10-29, PR 3 review, the blocker Stan and Adam found): the first call's `finish` and
    `advance` after `submit()` and its hook refusal's close moved whatever record they found, so
    after a reopen the first call's late `SignedHookError` ended the new claim `rejected` while
    its transaction could land (a double payment), and ran `onFinal` on it. `transition` takes
    the claim's `reopened` count and matches it in the same `UPDATE`; `advance` and `finish` take
    a guard (`version`, `claim`), and every write of a call passes its claim. Chosen over a read
    before each write (Stan's alternative: a reopen between the read and the write still lets it
    land).
25. **Records claimed before 0073 never reopen** (okarcz, 2026-10-29, PR 3 review, Adam's
    deploy window): the release before 0073 answered "sign a new payment", so reopening its
    records after the deploy let the old payment land beside a new one. The migration's default
    is -1, which the rows already there and the old release's inserts during the deploy get;
    `claim()` writes 0. `reopen()` and the `retryable` answer need `reopened` ≥ 0, so such a
    record answers as that release did. Chosen over accepting the window in writing.
26. **`onFinal` isn't promised once per claim** (okarcz, 2026-10-29, PR 3 review): `unconfirmed`
    is keyed by key alone, so a claim's lost final write may never get its hook once a later
    claim finishes, and across processes a claim's hook can repeat. `hooks.ts` says so, and
    0024 gets "idempotent release, and an expiry for a reservation never released". Chosen over
    keying `unconfirmed` by key and claim (one process only; 0024 needs idempotency anyway).
27. **#89 keeps migration 0006; ours is `0007_settlement_reopened`, #92's `0008_lease_token`**
    (okarcz, 2026-10-29, PR 3 review): #89 is one PR and likely merges first; ours is applied
    nowhere shared, so renaming it is free. Chosen over #89 renumbering and over leaving it open.

## Implementation Notes

### PR 1: the cap

- `MAX_VALIDITY_LEDGERS` in `config.ts` (default 66, must be above `MIN_VALIDITY_LEDGERS`),
  `maxValidityLedgers` in `VerifierDeps`, wired by `buildChecks()` into `/verify` and
  `settleCheck()` alike.
- `verify.ts`: refused after the too-soon check, before the uint32 one, with
  `EXPIRATION_TOO_FAR_REASON`. The message names the ledgers and the cap, plus a
  `maxTimeoutSeconds` hint when the resource asked for more than the advised ceiling (300 s at
  66), not the cap (replaced by decision 22's refusal in review 2).
- Tests: the boundary for both credential types, a 7-day request, no hint for a short request
  signed long, the uint32 test with the cap raised, `/verify` and `/settle`'s check through
  `buildVerifier`, the config default and its floor. Two mutants caught (cap off by one, cap off).
- Docs: the facilitator README's settings (ask for `maxTimeoutSeconds` ≤ 300), spine AD-22.
- Review (four reviewers): 3 decisions (8-10), 3 fixes (the README says `…_too_far` needs new
  requirements; these records; the smoke script's header), 1 deferred: `token-matrix.ts` and
  `verify-smoke.ts` don't pass `DATABASE_URL` either, broken since 0064.
- Review 2 (Adam, Stan; PR #80): decisions 21-23, and decisions 6, 8, 9 amended. `verify.ts`: a
  payer-only check after `payerNonce` (`hasOtherAddressAuth`, `payerNonce` and `keyOf()`
  unchanged), the `maxTimeoutSeconds` ceiling refused before the gap, the gap's hint dropped.
  Tests: an extra address's entry (short-lived one included) through `/verify` and `/settle`'s
  check; 300 accepted and 301 refused; the same hourly payment refused again 660 ledgers later;
  a 300 s payment signed at 4 s; `MAX_VALIDITY_LEDGERS=80` in both and the ceiling (363 s);
  `/settle` accepting +66. Changed: the 7-day test (now refused on `maxTimeoutSeconds`), the
  "4.8 s" hint test (now the 4 s case), "counts the earliest expiring auth entry" (now refused
  by decision 21). Docs: README settings and `…_too_far` row, AD-6, AD-22, the threat model's
  auth-expiry section, `config.ts`.

### PR 2: the envelope lives as long as its auth entry

- `submitter.ts`: with `maxLedger` set, `prepare()` builds the envelope with `maxTime` 0 (no time
  bound) and leaves `Prepared.maxTime` unset. `pastBounds`, `confirm()`, `expiresSoon()`,
  `awaitSigned()` and the TRY_AGAIN_LATER resend use the time bound only when there is one.
  `SignedBounds.maxTime` and the store's `AttemptBounds.maxTime` are optional; the store already
  writes null and reconciliation already skips a missing one. Calls without `maxLedger` keep
  `timeoutSeconds`.
- `dueAt`, when `submit()` answers `pending` while the confirmation runs on, is the ledgers left
  × 6 s (`LEDGER_SECONDS_ESTIMATE`, from 0043's 5.0–5.8 s) plus `confirmGraceSeconds`, counted
  once per envelope from the newer of the clock and the simulation's ledger. The same estimate
  ends a resend's wait and the `onSigned` ledger watcher, and a resend loop past it stops and
  confirms by hash (review).
- Tests (signer-pool 151 → 154): no time bound on a ledger-bounded envelope and its `onSigned`
  bounds; a stalled transaction confirmed for 150 s and `expired` only past its ledger bound,
  with the channel back; one that lands at about 2 minutes ends `success`; calls without a
  ledger bound keep their time bound. Mutants: the 60 s bound put back (4 tests fail), the ledger
  check dropped from `confirm()` (the test never ends).
- Review tests: a stalled `submit()` answers `pending` at about 60 × 6 + 30 s on a real ledger
  sequence with an unpolled clock; a resend after TRY_AGAIN_LATER with the RPC down still
  answers `pending`; a prepared-ahead ledger-bounded envelope is used, not rebuilt; reconciliation
  keeps a ledger-only record open past 60 s until its ledger passes (signer-pool 154 → 157,
  facilitator 527 → 528). Mutants: counting from the clock fails; the deadline removed hangs.
- `test/drain-takeover.test.ts` (facilitator 525 → 527): process 1 sends and is answered
  `pending`, its drain ends at a 300 ms deadline without releasing the lease, then its RPC hangs
  as after SIGKILL. Process 2 can't take the lease until the TTL and skew margin pass, then takes
  it, and its reconciliation ends the record `expired` or `success`.
- Docs: spine AD-22, the facilitator README (drain step 3, the `…_transaction_expired` row and
  repeats), ADR 0006, ADR 0011 (stop grace, pool bounds, crash recovery).

#### Issues encountered

- **The drain test needs its own file.** In `settle-pool.test.ts` every settlement uses one
  payer and nonce, so an earlier test's call still running after its own end wrote onto this
  test's record after `beforeEach` emptied the tables (the record ended `rejected`). A file of
  its own gets its own schema.
- **`FakeRpc` closes a ledger on every read.** The pool's polls passed 60 ledgers within the
  300 ms drain, so the transaction expired before the deadline. The test freezes ledgers while
  process 1 runs.
- **The record was still `signed`, not `pending`, when the drain ended**, so the test accepts
  either open state.
- **Code review (four reviewers), all 7 fixes applied** (okarcz picked each): the resend wait and
  `onSigned` watcher had no deadline once the time bound was gone, so an RPC outage after a
  TRY_AGAIN_LATER held `submit()` and its channel indefinitely; `dueAt` counted from a clock that
  reads 0 on a fresh submitter (a year instead of about 6.5 minutes); three tests; stale 60 s
  texts in the README, ADR 0011, ADR 0006 (now a dated amendment), `main.ts` and `settle.ts`;
  the drain test closes process 2 and its second case is renamed; a 5 s timeout on the pool test.
- **PR 2 review (Adam, Stan; #85), on the rebased branch:** decision 11 amended; docs: the drain
  figures at 6 s a ledger (426 s by default, 750 s at 120) in the README's drain step, ADR 0011's
  grace row and hosting reasons and the submitter's option docs; the `…_transaction_expired` row
  and the reconciliation text for a record signed before 0073; spine AD-22 and ADR 0006 scope
  "true when answered" to our outer hash; a `CHANNELS` note on held channels; ADR 0011 and the
  README accept the post-deploy `txBadSeq` for testnet. Tests (signer-pool 157 → 160): resends
  stop at the estimated time on 8 s ledgers, and when the RPC stops answering; the `onSigned`
  watcher stops at it. Mutants: the `break` removed (both resend tests fail), the watcher's
  deadline removed (the run hangs). Backlog: 0087 (confirm by the inner hash, high), 0088
  (`NOT_FOUND` at the bound ledger), 0089 (held-channel metric and alert), 0090 (skip a channel
  left open by the last process, before pubnet).
- **A test whose `submit()` answered `pending` hung after its assertion**: with the pool's no-op
  `sleep` and a ledger that never moves, the background confirmation never yields. The tests let
  ledgers close again after the answer.

### PR 3: an unsent payment reopens for the identical payload

- **PR 3 review (Stan, Adam; #86), on the branch rebased onto the fixed #85:** decisions 24-27,
  decision 19 amended. Code: `transition(…, expectedVersion?, claim?)` matches `reopened` in the
  `UPDATE`; `records.ts` `WriteGuard` (`version`, `claim`) on `advance` and `finish`; the call's
  writes in `settle.ts` pass `{ claim: claimed.reopened }`, the hook refusal its claim;
  migration `0007_settlement_reopened` defaults to -1, `claim()` writes 0, `reopen()` and
  `reopenable()` need ≥ 0, a replay of a -1 record carries `claimedBefore0073` and no `retryable`;
  `validity()` reads the payer's own entry (`payerExpiration`, `transferFrom`). Docs: README
  (the shutdown step, the deploy and rollback paragraph, the migration list), ADR 0011 (the
  budget's `…_timeout`, the deploy window and rollback), ADR 0006 (every writer named),
  `hooks.ts`, 0024's constraint.
- PR 3 review tests (facilitator 549 → 558): the fake pool's late signing rejects `submit()`
  with `SignedHookError` as the real one does; the earlier claim's late refusal leaves a
  reopened claim alone, signed and not yet signed (a repeat with its own budget); a record
  claimed before 0073 (-1) doesn't reopen, isn't re-checked and has no `retryable`; an older
  release's insert gets -1 on PostgreSQL; `transition` with an earlier claim fails (contract).
  Adam's six: `main.ts`'s `latestLedger` wiring (`settle-pool.test.ts`, its own nonce, 0084's
  leak), the sweep's versioned `interrupted` close, `endUnsigned`'s version and the "not signed
  yet" answer after it, the 1 s ledger read bound, `extra` on a `…_timeout` before the claim.
  Changed: the old-schema read test inserts its row as that release did (`claim()` now writes
  `reopened`); a `transition` assertion gets the claim; the one-ledger-left test's name and
  comment (Adam's nit). Mutants caught: no claim on the call's writes (3 tests), the claim
  ignored by `transition`, the marker off in `reopenable()`, in `reopen()`'s SQL and on the
  answer, each of the six lines Adam named.

- Store: migration `0006_settlement_reopened` (`reopened integer NOT NULL DEFAULT 0`; since the
  review `0007_…` with `DEFAULT -1`, decisions 25 and 27), the
  record's `reopened`, and `SettlementStore.reopen(key, fingerprint, reasons, now)`: one `UPDATE`
  that moves `rejected → claimed` only for the same fingerprint, an unsent reason and no hash,
  clears `errorReason`, adds one to `reopened` and sets `createdAt` to the reopening call's start.
  The new `createdAt` matters: a concurrent repeat counts the first call's budget from it, and
  reconciliation closes a hashless claim `interrupted` by it, so the old time would end the new
  claim at once. AD-16's exception is written in the port, ADR 0006 and the spine.
- `settle.ts`: `UNSENT_REASONS` (the six reasons). A read record that `reopenable()` skips
  `replay()`: past the auth expiry (fewer than 2 ledgers left, or the ledger unreadable) it
  answers the stored outcome; otherwise it runs the check, and a refusal is answered as is with
  the record left alone. A passing check calls `reopen()`; one that loses falls back to
  `claim()`, which conflicts and replays the winner. `settlement_reopened` log line and
  `settlement_reopened_total`. `beforeSubmit` gets `reopened`.
- Answers: the outer `settler` adds `extra.retryable` and `extra.expirationLedger` to every
  unsent answer with no `transaction`, with the message "repeat the same payment, until ledger N"
  or "sign a new payment". `retryable` is also `true` when the latest ledger can't be read in
  1 s (`LEDGER_READ_MS`): repeating the same payload is always safe. `SettlerDeps.latestLedger`,
  wired from the checks' RPC read.
- Tests (facilitator 528 → 539): the store's reopen, its refusals (fingerprint, reason, hash,
  state, missing) and ten concurrent reopens; `/settle` reopens and settles once (hook sees
  `reopened` 0 then 1, then `already_settled`), two concurrent retries reopen once, past the
  expiry no check and no reopen, an unreadable ledger stays retryable, another payload on the
  nonce is `nonce_already_used`, a failing re-check leaves the record, a record with a hash or a
  hook refusal never reopens. Changed: the six reasons' mapping test now expects `extra`; the
  budget test's retry is now past the expiry (it reopened before). Mutants caught: no expiry
  pre-check, `createdAt` kept, the hash condition dropped, reopen off, an unreadable ledger not
  retryable. One survived and is equivalent: dropping `state = 'rejected'`, since only a rejected
  record carries an unsent reason.
- Docs: the facilitator README (the six rows and "Nothing sent"), ADR 0006, ADR 0011 (replaces
  "it is not planned"), the spine's AD-16, and 0024's reservation id per claim (decision 16).

#### PR 3 review

- Four reviewers: 4 decisions (17-20), 7 patches, 3 rejected (`created_at` overwritten, the
  reopen's compare-and-set not checking the expiry, `claim()` named in the spec where the code
  has `reopen()`). Report: the local review file for PR 3.
- Decision 17: `withRetry` gives three answers by ledgers left: 2 or more, `retryable: true`
  with "while the latest ledger is at most E-2"; 1, `retryable: false` with "may still land in
  ledger E: once it has closed, sign a new payment"; none, "sign a new payment".
- Decision 18: an unreadable ledger keeps `retryable: true`, and the message and README say to
  stop once the network is past `expirationLedger`.
- Decision 19: `reopen()` adds one to `version`; `endUnsigned` takes the version its caller read
  (a repeat passes the version of the record it first read, the call its claim's), the sweep's
  `interrupted` close passes the version it listed, and `addHash` takes the call's claim (its
  `reopened` count; the row lock re-checks it). A repeat whose close finds a claim reopened since
  answers `settlement_pending`, "not signed yet".
- Decision 20: backlog task 0082 (every answer that ended a payment that didn't land names the
  ledger after which signing again is safe).
- Patches: one ledger read per call, shared by the reopen and the answer (`validOnce`); the
  `onFinal` doc (once per claim, key by `reopened`); README (the exceptions' lead, the
  `…_shutting_down` sentence, the four "nothing sent" cases, the deploy window); a pre-reopen
  budget answer keeps `key` and `replay`; `settlement_reopened_total` by `reason`; ADR 0006 and
  0011.
- Tests (facilitator 539 → 545): the mapping test's reasons written out; a reopen of a record
  closed `interrupted`; exactly 2 ledgers left answers `retryable: true` and reopens; 1 and 0
  left; the earlier claim's late hash refused after a reopen, in one process and across two
  settlers on one store (the first call still within its budget); an unreadable auth entry
  answers without `extra`; the store's versioned close and claim-bound `addHash` after a
  reopen. Mutants caught: `>=` to `>` and `<` to `<=` at the floor, no version bump, `addHash`
  without the claim (store and settle), the repeat closing by its latest read, `interrupted` or
  `noChannels` dropped from `UNSENT_REASONS`, the one-ledger answer off.
