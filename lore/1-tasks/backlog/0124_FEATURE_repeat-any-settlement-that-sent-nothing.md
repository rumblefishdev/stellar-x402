---
id: "0124"
title: "Let every settlement that sent nothing be repeated as it is"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0006"]
related_tasks: ["0009", "0073", "0082", "0024", "0086", "0036"]
tags: [facilitator, settlement, payments, priority-medium, effort-medium]
links: []
history:
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: >
      Every new failure before a send had to be added to `UNSENT_REASONS` by hand, or the payment
      ended for good; 0036 and 0024 added four in a week.
---

# Let every settlement that sent nothing be repeated as it is

## Summary

A settlement record that ended `rejected` with no signed transaction reopens for the identical
payload while the payer's auth entry is valid, whatever its `errorReason`. `UNSENT_REASONS` goes:
a failure nobody listed no longer ends the payment for good. A record with a hash never reopens,
as today.

## Context

- Today only the reasons in `UNSENT_REASONS` reopen (0073 decisions 3, 5). The list grew from 7 to
  11: 0036 added the two signing failures, 0024 the floor and the spend store. Until 0036's second commit (`7c2ea3ff`), an OpenBao failure ended the payment
  for good.
- Why other refusals end the payment: 0009 decision 2 ("the client signs a new payment"; a reopen
  needed a store operation the port didn't have), 0073 decision 20 (out of that task's scope) and
  0024 decision 35 (a budget or breaker refusal is "a deliberate wait"). No reason found that
  protects money: the payer pays at most once, since the auth entry's nonce is used once on chain.
- Since 0082 every answer that ended a record says to sign again only after
  `extra.expirationLedger`, so a repeat of the same payload is the only way to pay before then. A
  refusal from the checks before the claim has no record and gets neither field (`withRetry`
  needs a key), though the README says the same payment may be sent again.
- Upstream's Stellar `exact` facilitator keeps no record, so any payment that wasn't sent can be
  sent again (`@x402/stellar` 2.28.0 `exact/facilitator/index.mjs`).

## Decisions so far

| # | What is done | From | vs the task | Who does the same (checked) | Code | Test |
|---|---|---|---|---|---|---|
| 1 | A record that ended with nothing sent reopens by default, also for a reason nobody listed | owner, 2026-11-06 | matches | upstream Stellar `exact`: no record, any unsent payment is sent again | | |
| 2 | No refusal without a send ends a payment for good: budgets, breakers, fee, simulation, hook errors, `unexpected_settle_error` included | owner, 2026-11-06 | changes 0024 decision 35 | upstream Stellar `exact`, as row 1 | | |
| 3 | `extra.retryable` says whether a repeat can succeed, per reason: `false` for a refusal the same payload always gets (`…_unexpected_balance_changes`, `…_payer_not_authorized`, `…_unsupported_credential`, `…_signature_expiration_too_soon`) and for a spend budget, whose 24 h window outlasts the auth entry; the payload still reopens | owner, 2026-11-06, after a devil's-advocate review | beyond it | x402-foundation/x402 Stellar `exact` sets `retryable` only on `TRY_AGAIN_LATER` (`typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts:353-368`@6a773db; not in `@x402/stellar` 2.28.0) | | |
| 4 | A refusal from the checks before the claim, which leaves no record, answers `extra.expirationLedger` and "don't sign a new payment before it", as an ended record does; `retryable` follows decision 3 | owner, 2026-11-06, after a devil's-advocate review | beyond it; closes 0086's scenario at its cause | | | |

## Not yet decided

- Whether 0086 is closed as superseded: its first criterion asks that a payment refused for its
  fee never settles through the facilitator, which row 2 reverses.

## Out of scope

- A database row for a refusal before the claim (the owner, 2026-11-06): the `verified` and
  `settled` log lines already keep every refusal with its reason and payer, 30 days in CloudWatch
  (ADR 0011). A row in `settlements` at that point would take the payer's in-flight slot and let
  anyone holding the payload write rows.

## Implementation

- `reopenable()` drops the `UNSENT_REASONS` check; `store.reopen()` drops its reason filter. The
  reopen still runs the full `/settle` check first (0073 decision 13) and passes the hooks again,
  so a budget still spent or a breaker still open refuses again.
- `withRetry` no longer needs a key: a refusal from the checks gets the expiration ledger too
  (decision 4).
- Every such ending answers `extra.retryable` and `expirationLedger`, as the unsent answers do
  now, with `retryable` set by decision 3. Update the facilitator README's settle answers and 0024 decision 35.

## Acceptance Criteria

- [ ] Given a record ended `rejected` with no hash and any `errorReason`, including one not
      defined today, when the identical payload returns while its auth entry has 2 or more ledgers
      left, then it settles once
- [ ] Given such an ending, when the client reads the answer, then it never says to sign a new
      payment before the expiration ledger, and says to repeat the same one only when a repeat
      can succeed (decision 3)
- [ ] Given a record with a hash, when the identical payload returns, then it doesn't reopen
- [ ] Given a reopen after a budget refusal, when the budget is still spent, then it is refused
      again with the same reason
- [ ] Given a refusal from the checks before the claim, e.g.
      `invalid_exact_stellar_payload_fee_exceeds_maximum`, when the client reads the answer, then
      it carries `extra.expirationLedger` and never says to sign a new payment before it
