---
id: "0153"
title: "Keep a payment a breaker refused in /verify from settling once the breaker closes"
type: BUG
status: backlog
milestone: 2
related_adr: ["0006"]
related_tasks: ["0086", "0024"]
tags: [facilitator, settlement, payments, priority-low, effort-small]
links:
  - ../active/0086_BUG_fee-refusal-replay.md
history:
  - date: "2026-11-18"
    status: backlog
    who: okarcz
    note: "Spawned from 0086 future work: 0086 records the checks' refusals only."
---

# Keep a payment a breaker refused in /verify from settling once the breaker closes

## Summary

`verifyWithBreakers` refuses a payment that passed the checks while a breaker is open (0024).
That refusal records nothing, so once the breaker closes, the same payment passes `/verify` and
`/settle`. If its seller had the payer sign another meanwhile, both can land.

## Context

0086 records every refusal of the checks as a `refused` record, wrapped inside the breakers, so a
breaker's refusal stays out. `/settle` already records its own breaker refusal: `beforeSubmit`
ends the claimed record `rejected` with the breaker's reason, which never reopens.

## Implementation

- Decide whether `/verify` records a breaker refusal with `refuse` (move `verifyWithRefusals`
  outside `verifyWithBreakers`), or answers it without inviting a new signature.
- Keep the answer's advice the same as for the checks' refusals.

## Acceptance Criteria

- [ ] Given a payment a breaker refused in `/verify`, when the same payment is sent again after
      the breaker closed, then it doesn't settle through the facilitator
