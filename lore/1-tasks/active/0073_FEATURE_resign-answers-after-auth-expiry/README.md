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
- [ ] Given a payment closed with nothing sent, when the identical payload comes back while its auth entry is valid, then it is settled once; after the expiration ledger the answer is "sign a new payment"; a different payload on the same nonce is still refused
- [x] Given a transaction sent just before SIGTERM with a 5-minute envelope, when the 180 s grace ends before it is final, then the next process takes the lease and its reconciliation ends the record with the transaction's real outcome (test)
- [ ] Given the decided rule, when the task ends, then the decision and the options considered are recorded in this task (decisions 1-12 so far, S-sign-again-rule)

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
