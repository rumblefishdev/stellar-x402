---
id: "0107"
title: "Give each API key holder a free quota and a fee budget apart from the shared ones"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0007", "0013"]
related_tasks: ["0024", "0105", "0106", "0108"]
tags: [facilitator, fees, budgets, before-pubnet, priority-high, effort-medium, platform]
links:
  - ../../../docs/adr/0007-fee-abuse-containment.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: per-key budgets close the shared-budget exhaustion on pubnet."
---

# Give each API key holder a free quota and a fee budget apart from the shared ones

## Summary

On pubnet each key holder (one Discord account, 0106) gets a free quota of settlements, on the
model of Coinbase CDP (1,000 a month, then $0.001 each), and its settlements count in a budget of
its own rather than in 0024's shared `asset:<C…>` and `tier:other` ones (decided by akot,
2026-11-03). Then a caller's self-payments use up only its own quota, which is what closes 0024's
"Shared budget exhaustion by Sybil self-payments" on pubnet. Charging past the quota is 0108 and
doesn't block pubnet: until then the operator raises an account's limit by hand.

## Implementation

- Per account: settlements per calendar month (1,000 by default) and a fee budget under it, so a
  key whose settlements cost the ceiling stops before it costs 1,000 ceilings. Every included
  settlement counts, a failed one too.
- One budget for all free quotas together, so many Discord accounts use up only the free traffic,
  not the accounts whose limit the operator raised.
- `global` stays, as the bound on the total loss; its value is set from the sum of the quotas and
  the float (ADR 0013).
- Past the quota, `/settle` refuses with a reason of its own before anything is signed; the
  operator raises one account's limit (config or the registry, to decide).
- Events for 0027: an account nearing and reaching its quota, the shared free budget nearing its
  limit.
- Docs: the facilitator README, ADR 0007, the threat model ("Shared budget exhaustion", "Targeted
  `payTo` budget exhaustion").

## Decisions to make here

- Whether the per-payer and per-`payTo` budgets still apply to keyed traffic, or are keyed by the
  caller too: a `payTo` budget shared by every caller still lets one key fill a seller's budget
  ("Targeted `payTo` budget exhaustion").
- Whether the quota is counted in settlements, in fees, or both as above.
- The month: calendar month in UTC, or a rolling 30 days.

## Acceptance Criteria

- [ ] Given a pubnet settlement with a key, when it reserves, then it counts in its account's
      budget and in `global`, not in the shared asset and tier budgets
- [ ] Given an account past its quota, when it calls `/settle`, then it is refused with nothing
      signed, until the month rolls or the operator raises its limit
- [ ] Given many accounts on free quotas, when together they fill the shared free budget, then an
      account with a raised limit still settles
- [ ] Given the quota and budget values, when this task ends, then they are config and recorded
