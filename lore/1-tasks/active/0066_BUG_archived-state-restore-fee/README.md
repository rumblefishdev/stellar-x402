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

The design is [S-option-b-design](notes/S-option-b-design.md). In short: the verdict and the
code stay upstream's; when the payment's own transaction lists archived entries
(`archivedSorobanEntries`), the message adds them after upstream's
`simulation-derived fee N stroops exceeds ceiling M stroops`. No extra RPC call.

## Acceptance Criteria

- [ ] Given a payment over the fee ceiling whose transaction lists archived entries, when
      `/verify` or `/settle` runs, then the answer keeps
      `invalid_exact_stellar_payload_fee_exceeds_maximum` and its message names the entries, and a
      test pins it
- [ ] Given a payment over the ceiling with no archived entries, or another refusal, then the
      answer is upstream's unchanged
- [ ] Given the choice, then the threat model's "Fee inflation by rent" records it and the
      facilitator README says how to restore the entries
