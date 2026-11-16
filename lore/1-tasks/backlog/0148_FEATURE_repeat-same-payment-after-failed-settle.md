---
id: "0148"
title: "Repeat the same payment after a failed settlement instead of signing a new one"
type: FEATURE
status: backlog
related_adr: ["0006"]
related_tasks: ["0073", "0082", "0141"]
tags: [settlement, payments, priority-medium, effort-medium]
links:
  - ../archive/0073_FEATURE_resign-answers-after-auth-expiry/README.md
  - ../archive/0082_FEATURE_ended-answers-name-auth-expiry.md
history:
  - date: "2026-11-16"
    status: backlog
    who: karolkow
    note: "Spawned from 0141 review: a failure that spent no nonce reopens on the identical payload."
---

# Repeat the same payment after a failed settlement instead of signing a new one

## Summary

When our transaction fails on chain, or the pool's simulation refuses it, the payer's nonce is not
spent: the network rolls a failed transaction back. The signed payload can still settle until its
expiration ledger. Today the record ends and the answer says "sign a new payment once ledger X has
closed" (0082). A new signature carries a new nonce, so the old payload and the new one can both
land. A repeat of the same payload can't pay twice: the nonce lands at most once. This task lets
such a record reopen on the identical payload, as the "nothing sent" reasons already do (0073
decision 5), and changes the advice to "repeat the same payment".

## Context

- A record is keyed by `network:payer:nonce` and its states move forward only (0019, AD-16). A
  repeat of an ended record gets the stored answer again.
- 0073 decisions 3 and 5: an unsent payment is retried as is, not re-signed, while its auth entry
  is valid, and its record reopens on the identical payload. That is the one written exception to
  AD-16.
- 0082 decision 1: `…_transaction_failed` and `…_transaction_submission_failed` wait for the
  expiration ledger before "sign a new payment", because the nonce was rolled back. Reopening them
  was not among its options.
- 0141: a nonce that another transaction used gets its own code and no advice; that case stays as
  it is.
- Upstream: the Starknet `exact` scheme says a reverted transaction rolls back the nonce, so the
  facilitator SHOULD allow the same payment to be retried, and evicts its dedupe key on a
  definitive failure (`specs/schemes/exact/scheme_exact_starknet.md`, x402-foundation/x402). The
  SVM facilitator deletes its settlement cache entry on a definite failure, so the same payload can
  be broadcast again (`typescript/packages/mechanisms/svm/src/exact/facilitator/scheme.ts`). The
  Stellar `exact` scheme states no rule on repeats.

## Implementation

- Decide which ended reasons reopen: every reason after which our transaction spent no nonce
  (simulation refusal, on-chain failure, submission refusal), the 0141 reasons excluded.
- Extend the reopen condition in `settle.ts` and the advice table in `reasons.ts` (`ADVICE`,
  0141's follow-up PR): these reasons answer `retryable` and "repeat the same payment while the
  latest ledger is at most X−2", then "sign a new payment once ledger X has closed".
- Decide whether a repeat that fails on chain again, and costs a fee each time, needs a bound
  beyond the route's rate limit. Measure first.
- A reopened record answers success only for a transaction of ours that landed. Today a record
  turns `success` only from a hash among its own attempts (`settle.ts` pool result,
  `reconcile.ts` `land` and `resolved`, a rewrap of our own inner transaction per 0087). If
  another transaction used the nonce between our failure and the repeat, the repeat's checks
  answer 0141's `…_nonce_consumed_elsewhere`. The tests pin both.
- The answer when the record write fails (`answerResult` in `settle.ts`, from 0009) follows the
  same rule. Decide in this task whether a failure there answers the pool's code with "repeat"
  or `settlement_pending`, and drop its nonce read: once a repeat can't pay twice, the read only
  sharpens the code.
- README "What to do" column, ADR 0006.

## Decisions so far

1. **Every failure that spent no nonce reopens on the identical payload** (karolkow, 2026-11-16,
   0141 review): simulation refusal, on-chain failure and submission refusal alike; 0141's codes
   excluded. Chosen over reopening only simulation refusals and over keeping every failure final.
2. **We never confirm a payment another transaction made** (karolkow, 2026-11-16, 0141 review): a
   repeat after someone else used the nonce answers 0141's code, never `success`.

## Acceptance Criteria

- [ ] Given a payment whose transaction failed on chain while its auth entry is valid, when the
      identical payload is sent again, then the record reopens and the payment settles once
- [ ] Given the same after a pool simulation refusal, when the identical payload is sent again,
      then the record reopens
- [ ] Given such a failure, when `/settle` answers, then it says to repeat the same payment, with
      `retryable` and `expirationLedger`
- [ ] Given a nonce another transaction used (0141), when `/settle` answers, then nothing changes
- [ ] Given a failed payment whose nonce another transaction used before the repeat, when the
      identical payload is sent again, then the answer is `…_nonce_consumed_elsewhere` and never
      `success`, from `/settle`, the reconciliation sweep and the pool's `resolved` event alike
