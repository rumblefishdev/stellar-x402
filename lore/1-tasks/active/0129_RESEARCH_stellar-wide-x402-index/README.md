---
id: "0129"
title: "Research a Stellar-wide index of x402 settlements"
type: RESEARCH
status: active
related_adr: ["0008"]
related_tasks: ["0122", "0063", "0044"]
tags: [bazaar, discovery, research, grant-extension, priority-medium, effort-medium]
links:
  - ../../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-10"
    status: active
    who: karolkow
    note: >
      Created for the team lead, who will pitch a Bazaar that rests on Stellar network traffic,
      not on one facilitator's data, to partners as an extension of this grant.
  - date: "2026-11-12"
    status: active
    who: karolkow
    note: >
      Renamed. A larger measurement corrected the time-limit rule and the USDC total in
      notes/R-network-index-measurements.md.
---

# Research a Stellar-wide index of x402 settlements

## Summary

As the team lead, I want a refined, evidence-backed proposal for an open index of x402 traffic on
Stellar, so that I can pitch it to partners and funders as an extension of this grant.

## Context

- Every x402 Bazaar today lists only the sellers whose payments its own facilitator settled. On
  pubnet, Coinbase's public CDP catalog knows 5 of the 16 accounts that received real x402 payments
  in the 30 days to 2026-11-09 (`notes/R-network-index-measurements.md`).
- An x402 settlement is visible on chain, so an index can see every seller and payer across all
  facilitators. The chain carries accounts and amounts, not service URLs.
- The current grant already promises search ranking with buyer reach, distinct buyers in a
  trailing window (our proposal, `docs/rfp/x402-facilitator-bazaar-technical-architecture.md:154-168`;
  the RFP's evaluation criteria ask for search with ranking too). The extension must add something the
  grant does not.
- Interop with other catalogs inside the current grant is task 0122.

## Decisions so far

| #   | What is decided                                                                                                                                                                                                                                                            | From                                      | Vs the task        | Who does the same (checked)                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | The extension rests on indexing x402 settlements across the whole Stellar network, not on our facilitator's data                                                                                                                                                           | team lead, 2026-11-10                     | the task's premise | x402 spec leaves indexing to implementations (`specs/extensions/bazaar.md`)                     |
| 2   | Its core is an open index: a public dataset with versioned rules, a "paid by an independent account" mark per seller, and finding sellers missing from catalogs. The payer count is shown beside a listing, not used as the sort order; ranking stays in the current grant | owner, 2026-11-10                         | beyond it          | upstream x402-foundation/x402#3226: catalog popularity counters can be minted without a payment |
| 3   | Build on an existing open-source Stellar settlement classifier instead of writing a new one                                                                                                                                                                                | owner, 2026-11-10 (from a premise review) | beyond it          | —                                                                                               |
| 4   | The seller crawler (account → service URL, confirmed by the seller's unpaid 402) stays in scope                                                                                                                                                                            | owner, 2026-11-10                         | beyond it          | —                                                                                               |
| 5   | Everything for the team lead is in English. The pitch document goes to a Google Doc; notes in this repo name no other facilitators                                                                                                                                         | owner, 2026-11-10                         | —                  | —                                                                                               |

## Not yet decided

- The milestone scope to pitch (smallest first step, total size).
- The form of the Google Doc and who owns it.
- Where the list of other contribution ideas lives.

## Out of scope

- Changing what the current grant delivers; this task only prepares a proposal.

## Notes

- `notes/R-network-index-measurements.md`: what the pipeline found on pubnet and testnet.

## Acceptance Criteria

- [ ] A note records the measurements behind the proposal, with method and limits
- [ ] A design note lists components, milestones with effort and stop rules
- [ ] The English pitch document is ready for the team lead
