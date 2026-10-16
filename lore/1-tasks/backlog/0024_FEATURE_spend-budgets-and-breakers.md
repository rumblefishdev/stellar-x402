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
  Resolving `false` lets the caller log it; inserting the spend needs the scopes. 0022 now
  resolves `false` (its decision 17); what the caller does with it is still this task's.
- A lost `onFinal` call after a crash leaves the reservation counted until it ages out of the
  rolling window; acceptable for T1 (0017, Stan's PR #7 review).
- Option from 0022's third review, to verify rather than a decision (a better approach may exist): `release` is an unconditional DELETE. Releasing a reservation that was already committed
  (a duplicate final call, or a re-check that reclassifies a landed transaction) removes a fee
  that was actually paid from every budget window. One option: a `committed` flag on
  `spend_reservations`, with `release` deleting only `WHERE NOT committed` and `commit` returning
  whether a row matched. This goes with the open decision on `commit` for an unknown id above,
  and with 0009's "refuse a reserve after its release": a reservation status
  (`reserved | committed | released`) kept as a row instead of deleting it would cover both.
  0022 took the status (its decision 17): `state` is `reserved` or `committed`, `release` deletes
  only `reserved` rows, and `commit` resolves `false` for an unknown id. Refusing a reserve after
  its release is still open here; it can add `released` as a kept row.
- From 0022: `reserve` can reject when the store is busy or unreachable (`55P03` after the 2 s lock
  timeout, no `reservePool` connection within 5 s, a lost `COMMIT` answer). Answer it on purpose,
  e.g. 503 with a retry, not 500; a retry with the same `id` is safe, as the port says.
- From 0009 (PR #41 reviews):
  - **`beforeSubmit` must answer within the settle budget.** Past it, the record ends with
    `…_timeout`, and `onFinal` runs once the hook's promise settles, whatever it answered (0009
    decision 34), so a reservation made late is released. `onFinal` may also come for a
    reservation that was never made: a refusal the store couldn't record ends later with
    `onFinal` (`hooks.ts`).
  - **Fee griefing by spending one balance in parallel** (Adam, third review). One payer funded
    with exactly one `amount` signs N payments with N nonces and sends N `/settle` calls at once.
    Each passes both simulations, N channels submit in one ledger, and N−1 fail on chain, at our
    fee. A local probe had two payments from one payer reach `submitter.submit` concurrently.
    The per-asset breaker makes it worse: 6 parallel calls would open the USDC breaker for every
    seller for 10 minutes, at will. Needs: at most one non-final settlement per (payer, asset), or
    in-flight amounts reserved against the balance; and balance-race failures counted against the
    payer, not the asset.
  - Refusal reasons are an `errorReason` sellers see; the README lists "a spend reason" as a
    refusal that ends the payment (sign a new one later).

## Acceptance Criteria

- [ ] Given a global rolling fee budget and per-payer, per-`payTo` and per-asset budgets, when the before-submit hook runs, then it reserves the fee against all of them; over any budget, `/settle` returns `success: false` and submits nothing
- [ ] Given a settlement outcome, when it is final, then the reservation is settled at the fee actually paid or released
- [ ] Given repeated on-chain failures for one asset or one `payTo`, when the threshold is reached, then that breaker opens and settlements for it are refused until it resets
- [ ] Given a budget nearing its limit or a breaker opening, when it happens, then an event is emitted for the alerts in 0027; state goes through `SpendStore`, and the numeric limits are in config and recorded in this task
