---
id: "0086"
title: "Keep a payment the checks refused from settling after its payer signed again"
type: BUG
status: active
owner: okarcz
milestone: 2
related_adr: ["0006"]
related_tasks: ["0073", "0009", "0153"]
tags: [facilitator, settlement, priority-medium, effort-medium, payments, before-pubnet]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073 decision 23 (PR #80 review): the same replay as `…_too_far`, which
      decision 22 closed on the requirements; a fee isn't in them.
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Payments lane, M2, before pubnet (okarcz, unlaned M1 check): a fee refusal still records nothing, so the double charge is still possible.
  - date: "2026-11-18"
    status: active
    who: okarcz
    note: "Started by okarcz: Payments lane, M2, before pubnet."
  - date: "2026-11-18"
    status: active
    who: okarcz
    note: >
      Scope widened from the fee refusal to every check refusal that can pass later (okarcz);
      title and acceptance criteria follow. Breaker refusals in /verify spawned as 0153.
---

# Keep a payment the checks refused from settling after its payer signed again

## Summary

`/verify` and `/settle`'s checks refuse a payment with `invalid_exact_stellar_payload_fee_exceeds_maximum`
when our fee estimate is above our ceiling. The refusal records nothing, so the same payment
passes once fees drop. If its payer signed a second payment meanwhile, both can land.

## Context

- The scenario: P1 is refused on a fee spike, the seller asks for a new signature and settles P2,
  then P1 is sent again (a retry with backoff, a queued replay) after the spike and settles too.
  The README's "Callers" section says such a refusal "may succeed later", but nothing stops a
  seller from asking for a new signature meanwhile.
- Already on develop before 0073. 0073 decision 22 closed the same path for `…_too_far` by
  refusing on the resource's `maxTimeoutSeconds`, which doesn't change over time; a fee does.
- A refusal after the claim (`settle_exact_stellar_fee_exceeds_maximum`) is recorded already, and
  is not in #86's `UNSENT_REASONS`, so its record stays final and a replay is answered from it.
- Whoever holds P1 can always submit it on chain without us; this task is about our own path.

## Implementation

- Options seen in 0073's review: store a final `rejected` record under the payment's key on the
  refusal (`claim` then `finish`, in `/verify` and `/settle`), so AD-6's lookup answers a later
  attempt; or answer the refusal so the seller retries the same payment instead of asking for a
  new one. To be chosen when the task starts.
- If records are stored: `/verify` starts writing, so decide what a failed write answers and
  whether `/verify` refuses any known key.

## Acceptance Criteria

- [ ] Given a payment the checks refused (fee, low balance, missing trustline, ledger gap, or any
      other reason) in `/verify` or `/settle`, when the same payment is sent again after the reason
      no longer holds, then it doesn't settle through the facilitator
- [ ] Given that refusal, when the seller reads the answer, then it says what to do without
      inviting a second signature that can land next to the first
- [ ] Given a `/verify` refusal the store can't record, when the seller reads the answer, then it
      is a 503 that invites the same payment again, not a new signature
- [ ] Given a refusal record past its auth entry's expiry, when the pruner runs, then the record
      is deleted and no other settlement record is

## Design Decisions

### From Plan

1. **A final record, not only an answer** (okarcz, of the two options above): the facilitator
   refuses the payment for good, so the answer can say what to do safely. An answer alone
   (`retryable`) would leave AC1 open to a seller that ignores it.
2. **Every check refusal of a payload with a key** (okarcz, wider than the fee): the fee isn't the
   only refusal that can pass later; a low balance, a trustline added later and the ledger gap of
   `…_too_far` have the same path. No list of reasons: a new upstream reason is covered by
   default, and one that can never pass costs a row.
3. **A `refused` state in `settlements`** (okarcz, over a separate table): a second start next to
   `claimed`, final, holding no payer and asset slot. `refuse` inserts it, or moves a
   reopenable `rejected` record of the same payment to it, AD-16's second written exception.
   Blocking by key, not fingerprint: two payloads with one nonce can't both land, and another
   payload under the key gets `…_nonce_already_used`, as AD-6 answers.
4. **`/verify` answers 503 when the store fails to record a refusal**, `store_unavailable`: an
   unrecorded refusal would invite the second signature. `/settle` keeps its 500 before the claim.
   A failed lookup runs the checks instead (decision 14).
5. **The pruner deletes `refused` records once they can't land** (`REFUSED_HORIZON_MS`, at least
   1 h): the payer's expiration ledger must have closed too (decision 15). Settlement records were
   never pruned before.
6. **A transactional migration** (`0015_settlement_refused`): online migrations wait for 0080.
   `ADD COLUMN` holds reads and writes of `settlements` until the group commits, for one scan to
   build the partial index `WHERE state = 'refused'`: small on testnet and nothing on a new
   mainnet database. A group past its 1.5 s fails the run, unretried.
7. **One release, with a deploy note**: the release before reads `refused` as open and answers a
   repeat `settlement_pending` during the deploy; it never settles it.

### Emerged

8. **`error_message` and `error_detail` columns**: a repeat gets the checks' message again, the
   archived entries to restore included, and our own code next to upstream's reason
   (`extra.reason`), which the testnet check found missing. Nullable, in the same migration.
9. **The answer reuses the "ended" advice**: `/settle` sets the key, so `withRetry` adds "may still
   land in ledger N: sign a new payment once that ledger has closed" with
   `extra.expirationLedger`; `/verify` adds the same from the payload alone, with no ledger read.
10. **`refused` is never a `transition` target** (`isForward`): only `refuse` writes it.
11. **`/verify` reads the store before the checks**: a `refused` record of the same payload is
    answered without an RPC call. Any other record, or no answer, leaves `/verify` as before.
12. **2 s store timeout in `/verify`** (`VERIFY_STORE_TIMEOUT_MS`), for the lookup and the write:
    `/verify` has no budget of its own.
13. **A bogus payload can occupy a key**: a refusal is recorded before any signature check, so a
    payload naming someone's payer and nonce, refused, blocks that payment here. It needs the nonce
    first, and whoever has it can submit the payment on chain anyway (0141's front-run).

### From review (#205, Stan's comments, decided by okarcz)

14. **A failed lookup runs the checks**: a slow store no longer turns a valid payment into a 503.
    The lookup only saves RPC calls; `/settle` claims the key and answers from the `refused`
    record, so a refused payment that passes `/verify` during an outage still never settles. No
    counter: the log line `verify_store_lookup_failed` only.
15. **Pruned by expiration ledger**: upstream refuses on simulation and fee before any expiry
    check, and our "too far" checks are relative to the current ledger, so a payload signed for
    thousands of ledgers, refused for its fee, passed everything once the hour had gone. The
    record keeps `expiration_ledger`; the pruner reads the latest ledger once a tick and deletes a
    record of its network once that ledger has closed. A failed read prunes only records without
    one, which never pass the payer-auth check.
16. **"Under way" advice in `/verify`**: a refusal while a non-final record of the same payload
    holds the key says to ask `/settle` for its outcome before signing a new payment.
17. **`refuse` leaves a pre-0073 record** (`reopened` -1) as it is, as `reopen` does: moved to
    `refused`, its old `created_at` let the pruner delete an AD-6 record.

## Future Work

- Breaker refusals in `/verify`: 0153.
