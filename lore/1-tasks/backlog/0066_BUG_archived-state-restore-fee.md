---
id: "0066"
title: "Decide what /verify does when a payment must restore archived state"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0021", "0007"]
tags: [facilitator, exact, fees, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: okarcz
    note: "Spawned from 0021's testnet run."
---

# Decide what /verify does when a payment must restore archived state

## Summary

Since Protocol 23 a transaction restores the archived entries it touches and pays their rent. A
buyer's `exact` payment that touches archived state, such as a token balance unused for weeks or
a SAC instance nobody kept alive, then costs far more: in 0021's run, 551,787 stroops of resource
fee for a SAC whose instance was archived and 342,189 for a non-SAC token whose payer balance was
archived, against 14,278 for live USDC. Both are above `MAX_FEE_STROOPS` (250,000), so `/verify`
answers `invalid_exact_stellar_payload_fee_exceeds_maximum`: a valid payment is refused, and the
buyer can't tell why or what would fix it.

0021's script restores such entries from the facilitator account before it pays. Decide what the
facilitator itself does.

## Options

- Restore the entries the simulation reports as archived (`archivedSorobanEntries`) from the
  facilitator account, then let the buyer's transaction go through. Costs XLM per restore and is
  a new way to spend the facilitator's balance (spend budgets, AD-18).
- Keep refusing, but with a reason that names the archived state, so the seller or buyer can
  restore it.
- Raise or split the fee cap for restore rent. Every payment's worst case grows.

## Acceptance Criteria

- [ ] Given a payment whose simulation restores archived entries, when `/verify` runs, then the
      answer follows the chosen option and a test pins it
- [ ] Given the choice, then AD-10 (fees) or the threat model records it
