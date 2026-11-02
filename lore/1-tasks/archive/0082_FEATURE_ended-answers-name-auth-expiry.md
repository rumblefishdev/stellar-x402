---
id: "0082"
title: "Say when to sign again in every answer that ended a payment that didn't land"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0006", "0011"]
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
  - date: "2026-11-02"
    status: active
    who: okarcz
    note: "Work started."
  - date: "2026-11-02"
    status: completed
    who: okarcz
    note: >
      Merged in #108, rebased over 0093 with no conflict. All three criteria met. On the rebased
      tip: facilitator 662 tests (10 new), signer-pool 160, MCP 112. Only fakes reach the new
      answers: the testnet smoke run covers the normal path. No follow-up tasks.
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
    decision 15): that envelope was never sent, but the record has a hash, so it doesn't reopen.
    One renewal that fails on a store error is enough: it drops the lease in memory, so every
    `addHash` in flight stores its hash and fails the check after it. A freeze with no takeover
    ends the same way, since the fence compares the token and not `expires_at`;
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
- Decide whether the `…_lease_lost` records above can reopen. 0082's message makes these answers
  safe, but they still can't: `attemptUpdates` writes "never sent" and "refused" alike as `dead`,
  so a reopen needs an attempt state that tells them apart. For the freeze alone, the fence could
  also refuse an expired lease.
- Update the facilitator README's "What to do" column and ADR 0006.

## Acceptance Criteria

- [x] Given a payment refused after its claim while its auth entry is valid, when `/settle`
      answers, then the answer carries `expirationLedger` and says to sign again only after it
- [x] Given the same answer after the expiration ledger has closed, when `/settle` answers, then
      it says to sign a new payment
- [x] Given the README's settle answers, when they are read, then no row says to sign again
      before the auth entry's expiry without saying so

## Design Decisions

### From Plan

1. **`…_transaction_failed` and `…_transaction_submission_failed` wait too, `…_transaction_expired`
   doesn't** (okarcz, 2026-11-02): a failed transaction rolls its changes back, the auth entry's
   nonce too, so the payload can land in a new envelope until its expiry. `…_transaction_expired`
   comes only after that expiry. Chosen over all three (`expired` gains nothing) and over leaving
   the three as they are (the payer can still pay twice).
2. **`…_lease_lost` records with a hash stay closed** (okarcz, 2026-11-02): the answer says to sign
   again after ledger N, which is safe, at the cost of a wait of a few minutes in a rare case.
   Chosen over a new attempt state that lets them reopen (more change on the money path) and over
   also refusing an expired lease in the fence (it covers the freeze, not a renewal that fails on a
   store error).

### Emerged

3. **The rule is "a failed answer about a record", minus a short list** (`NOT_SIGN_AGAIN`): the task
   names many reasons, and a hook's spend reason is any string. An answer has a `key` only once a
   record exists, so the checks' refusal of a first payment stays out. A list of reasons to include
   would miss the next one, on the unsafe side.
4. **Every refusal after the claim waits, the malformed ones too** (okarcz, 2026-11-02, code review):
   `…_unexpected_balance_changes` and the unsupported credential refusal were first left out as
   malformed. A client's next step is a corrected payment, and the first can still land elsewhere
   until its expiry. It changes the answer only, and costs one ledger read on rare answers. Chosen
   over keeping them out.
5. **A record claimed before 0073 keeps its answer** (`claimedBefore0073`): no `extra`, as 0073
   decision 25 has it for the "nothing sent" reasons, here for every reason. This is the one case
   that still says "sign a new payment" at once; those records are from testnet, before the cap on
   the auth entry's life.
6. **The checks' refusal of a reopen answers `retryable: true`** (okarcz, 2026-11-02, code review):
   amends the task's "`retryable: false`". That record stays closed with nothing sent and can still
   reopen, so a repeat after a fee spike settles once, and `false` would make a client drop it. The
   advice comes first, since a client reads the archived entries at the end of the checks' message
   (0066). Chosen over `false` with a README exception.
7. **No new read limit**: a repeat of an ended record now costs one ledger read per call, bounded by
   `LEDGER_READ_MS`, as an unsent one does. The route's rate limit covers it. A reopen reuses its
   read, so its answer can say to wait just after the ledger closed: safe, and the next repeat
   corrects it.
8. **MCP logs the facilitator's message and tells the agent nothing new** (okarcz, 2026-11-02, code
   review): the agent is already told not to pay again without checking, and a ledger would come
   through the seller, who could send a low one to get a second payment. Chosen over showing the
   ledger to the agent and over leaving `pay.ts` alone.

## Implementation Notes

- `settle.ts`: `withRetry` gives the new answers, so a repeat from the record gets them too, worked
  out from the ledger of that moment. An unreadable ledger keeps the wait.
- `packages/mcp/src/pay.ts`: the log detail carries `errorMessage`.
- README: the settle table's "What to do", a new "Ended" section. ADR 0006 and ADR 0011: the wording.
  Threat model: a new entry with its residual risks.
- Tests: 10 new in `settle.test.ts` (131 there), 662 in the facilitator. Changed expectations, all
  from the new `extra` and message, intentional: 14 cases in `settle.test.ts` (failed, rejected,
  thrown reasons, store failure, `…_record_write_failed`, `…_lease_lost`, a record with a hash), the
  fenced rebuild in `settle-pool.test.ts`, and the log in `packages/mcp/test/pay.test.ts`.
- 16 mutants caught: no key guard, `left >= 0`, an unread ledger saying sign, the hash check dropped,
  `retryable: true` on an ended answer, the message dropped, its order, `reopenRefused` unset and
  always set, each of the four `NOT_SIGN_AGAIN` reasons removed, `claimedBefore0073` ignored and
  ignored for a record with a hash, and a second ledger read.
- Testnet: `scripts/settle-smoke.ts` on a fresh database, 5 of 5. It covers the normal path, not an
  ended answer.

## Code Review

Four layers, 2026-11-02: 2 decisions (4, 6 above), 7 patches applied, 1 deferred finding resolved
(8 above), 5 rejected.
