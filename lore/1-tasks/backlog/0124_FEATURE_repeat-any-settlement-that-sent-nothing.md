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
- Since 0082 every ended answer says to sign again only after `extra.expirationLedger`, so a
  repeat of the same payload is the only way to pay before then.
- Upstream's Stellar `exact` facilitator keeps no record, so any payment that wasn't sent can be
  sent again (`@x402/stellar` 2.28.0 `exact/facilitator/index.mjs`).

## Decisions so far

| # | What is done | From | vs the task | Who does the same (checked) | Code | Test |
|---|---|---|---|---|---|---|
| 1 | A record that ended with nothing sent reopens by default, also for a reason nobody listed | owner, 2026-11-06 | matches | upstream Stellar `exact`: no record, any unsent payment is sent again | | |
| 2 | No refusal without a send ends a payment for good: budgets, breakers, fee, simulation, hook errors, `unexpected_settle_error` included | owner, 2026-11-06 | changes 0024 decision 35 | upstream Stellar `exact`, as row 1 | | |

## Not yet decided

- Whether 0086 is closed as superseded: its first criterion asks that a payment refused for its
  fee never settles through the facilitator, which row 2 reverses.

## Implementation

- `reopenable()` drops the `UNSENT_REASONS` check; `store.reopen()` drops its reason filter. The
  reopen still runs the full `/settle` check first (0073 decision 13) and passes the hooks again,
  so a budget still spent or a breaker still open refuses again.
- Every such ending answers `extra.retryable` and `expirationLedger`, as the unsent answers do
  now. Update the facilitator README's settle answers and 0024 decision 35.

## Acceptance Criteria

- [ ] Given a record ended `rejected` with no hash and any `errorReason`, including one not
      defined today, when the identical payload returns while its auth entry has 2 or more ledgers
      left, then it settles once
- [ ] Given such an ending, when the client reads the answer, then it says to repeat the same
      payment until the expiration ledger, never to sign a new one before it
- [ ] Given a record with a hash, when the identical payload returns, then it doesn't reopen
- [ ] Given a reopen after a budget refusal, when the budget is still spent, then it is refused
      again with the same reason
