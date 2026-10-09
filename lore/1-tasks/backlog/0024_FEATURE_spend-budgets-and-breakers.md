---
id: "0024"
title: "Spend budgets and circuit breakers"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0012", "0017", "0009"]
tags: [facilitator, security, fees, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.3 (Platform lane)."
---

# Spend budgets and circuit breakers

## Summary

As a facilitator operator, I want fee spending capped and failing assets or recipients cut off, so that nobody can drain the facilitator's XLM with valid self-payments or junk tokens.

**Story:** [M1 Story 2.3](../../../docs/planning/m1-epics.md#story-23-spend-budgets-and-circuit-breakers) · **Lane:** Platform · **Covers:** FR13 (AD-18)

## Context

- IP limits can't stop drain through valid payments; this can (ADR 0007).
- Plugs into the before-submit hook from 1.1, so it can be built and tested with a fake settle before 0009 is done.
- Related tasks: 0017, 0009.

## Implementation

- `SpendBudgets` policy module behind `SpendStore`, wired to the before-submit hook in the composition root.
- Breakers per asset and per `payTo`, fed by settlement outcomes.
- Tests with the in-memory store and a fake settle.
- Decide what `SpendStore.commit` does for an id with no reservation (0017, Oskar's PR #11
  review): the in-memory store ignores it and the port says nothing. `onFinal` is its only
  caller and runs once at a final state, so it only happens after a bug or a lost store.
  Resolving `false` lets the caller log it; inserting the spend needs the scopes.
- A lost `onFinal` call after a crash leaves the reservation counted until it ages out of the
  rolling window; acceptable for T1 (0017, Stan's PR #7 review).

## Acceptance Criteria

- [ ] Given a global rolling fee budget and per-payer, per-`payTo` and per-asset budgets, when the before-submit hook runs, then it reserves the fee against all of them; over any budget, `/settle` returns `success: false` and submits nothing
- [ ] Given a settlement outcome, when it is final, then the reservation is settled at the fee actually paid or released
- [ ] Given repeated on-chain failures for one asset or one `payTo`, when the threshold is reached, then that breaker opens and settlements for it are refused until it resets
- [ ] Given a budget nearing its limit or a breaker opening, when it happens, then an event is emitted for the alerts in 0027; state goes through `SpendStore`, and the numeric limits are in config and recorded in this task
