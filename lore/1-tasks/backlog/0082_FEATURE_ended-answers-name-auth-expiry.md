---
id: "0082"
title: "Say when to sign again in every answer that ended a payment that didn't land"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0006"]
related_tasks: ["0073", "0024", "0071"]
tags: [facilitator, exact, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR 3 code review (decision 20): the six "nothing sent" answers now
      wait for the auth expiry; the other answers that end a payment still say "sign a new
      payment" at once.
---

# Say when to sign again in every answer that ended a payment that didn't land

## Summary

As a payer, I want every `/settle` answer that ended my payment to say from which ledger a new
signature is safe, so that I don't pay twice. Today only the six "nothing sent" answers (0073)
wait for the auth entry's expiry; the rest say "sign a new payment" while the payload I signed
can still land.

## Context

- 0073 decisions 1, 17: "sign again" is safe only once the auth entry's expiration ledger has
  closed. Until then whoever holds the payload (the seller's resource server, or anyone who saw
  the request) can build a new envelope around it, with another facilitator or later here.
- Still answered "sign a new payment" at once (0073 decision 20, out of its scope):
  - refusals after the claim: `…_simulation_failed`, `…_fee_exceeds_maximum`,
    `…_signature_expiration_too_soon` from the pool, `…_record_write_failed`, a spend reason,
    `…_refused`, `unexpected_settle_error`;
  - the `/verify` checks' refusal on a reopen (0073 decision 13), e.g. a fee spike;
  - a "nothing sent" reason that carries an earlier hash (a `txBadSeq` rebuild), which never
    reopens;
  - `…_lease_lost` with the hash the call stored just before it found the lease lost (0071
    decision 15): that envelope was never sent, but the record has a hash, so it doesn't reopen;
  - a reopen at exactly 2 ledgers left (0073's PR 3 review): the ledger can close while the pool
    simulates, and it then refuses with `LedgerBoundError`, answered
    `…_signature_expiration_too_soon` ("sign a new payment") while the payer's auth entry can
    still land in its expiration ledger. A first payment at 2 left has the same window, but
    0073's `retryable` answer aims repeats at it.
- Some of these can't land with the same payload anyway (a balance that is gone stays gone until
  it isn't); the answer still can't promise that.

## Implementation

- Add `extra.expirationLedger` to these answers, with the message "sign a new payment once
  ledger N has closed" while the latest ledger is below it, as 0073's `withRetry` does for the
  six (one ledger read per call, `retryable: false`).
- Decide whether `transaction_failed`, `submission_failed` and `transaction_expired` need it:
  a failed or refused envelope's auth entry can still land in another one before its expiry;
  `expired` comes only after it.
- Update the facilitator README's "What to do" column and ADR 0006.

## Acceptance Criteria

- [ ] Given a payment refused after its claim while its auth entry is valid, when `/settle`
      answers, then the answer carries `expirationLedger` and says to sign again only after it
- [ ] Given the same answer after the expiration ledger has closed, when `/settle` answers, then
      it says to sign a new payment
- [ ] Given the README's settle answers, when they are read, then no row says to sign again
      before the auth entry's expiry without saying so
