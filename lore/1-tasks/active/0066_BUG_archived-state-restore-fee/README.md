---
id: "0066"
title: "Decide what /verify does when a payment must restore archived state"
type: BUG
status: active
milestone: 1
related_adr: ["0007"]
related_tasks: ["0021", "0007"]
tags: [facilitator, exact, fees, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: okarcz
    note: "Spawned from 0021's testnet run."
  - date: "2026-10-27"
    status: active
    who: akot
    note: >
      Work starts.
---

# Decide what /verify does when a payment must restore archived state

## Summary

Since Protocol 23 a transaction restores the archived entries it touches and pays their rent in
its resource fee. The facilitator pays that fee (AD-10): the settlement is rebuilt on a channel
account and fee-bumped by the facilitator, so the buyer's own fee is never used. A payment that
touches archived state therefore costs the facilitator far more. In 0021's testnet run the
resource fee was 551,787 stroops for a SAC whose instance was archived and 342,189 for a non-SAC
token whose payer balance was archived, against 14,278 for live USDC. (A G-account's SAC balance is
a trustline and never archives; a non-SAC balance, a C-account's SAC balance, an instance or a
contract's code can.)

Both are above `MAX_FEE_STROOPS` (250,000), so `/verify` answers
`invalid_exact_stellar_payload_fee_exceeds_maximum`, and nobody can tell from the answer that
archived state adds the cost, or that anyone, buyer or seller, can restore the entries from their
own account (`RestoreFootprint`, `stellar contract restore`). Upstream checks the fee before the
transfer events and auth, so the payment is not known to be valid either.

## Decision

Option B: keep refusing, and say why. The facilitator does not pay restore rent above its
ceiling, and the reason code stays the one the x402 Stellar spec requires. Upstream, r402 and the
OpenZeppelin plugin all refuse too, and the x402 SVM spec forbids the fee payer from paying rent
([R-facilitator-survey](notes/R-facilitator-survey.md)). Rejected: paying the restore rent (a new
way to drain the facilitator) and raising or splitting the cap (every payment's worst case grows).

The design is [S-option-b-design](notes/S-option-b-design.md). In short:

- On `…_fee_exceeds_maximum` only, `/verify` and `/settle` (the `upfront` flow settles without
  verifying) run one bounded diagnostic simulation and read `archivedSorobanEntries`
  (`restorePreamble` as a fallback). The diagnosis never changes the verdict.
- The answer keeps upstream's code, adds `extra.reason: invalid_exact_stellar_payload_archived_state`
  with the entries, and appends them to `invalidMessage`.
- A log event and a metric count it; `flagDrift` doesn't treat it as drift.
- The facilitator README says what the refusal means and how to restore each kind of entry.

## Acceptance Criteria

- [ ] Given a payment whose simulation restores archived entries and whose fee is above the
      ceiling, when `/verify` or `/settle` runs, then the answer keeps
      `invalid_exact_stellar_payload_fee_exceeds_maximum`, names the archived entries, and a test
      pins it
- [ ] Given a refusal with no archived entries, another refusal code, or a diagnostic simulation
      that fails, then the answer is upstream's unchanged and the happy path makes no extra call
- [ ] Given the choice, then AD-3 (the `/verify` and `/settle` steps), the threat model's "Fee
      inflation by rent" and ADR 0007 record it, and the facilitator README tells buyers and
      sellers how to restore the entries
