---
id: "0165"
title: "Don't seed a Stellar listing whose payTo can't receive its asset"
type: FEATURE
status: backlog
milestone: 3
related_adr: ["0008"]
related_tasks: ["0094", "0155", "0154", "0078"]
tags: [facilitator, bazaar, catalog, priority-low, effort-small]
links:
  - ../active/0094_RESEARCH_tell-seller-about-missing-trustline/notes/S-recommendation.md
history:
  - date: "2026-11-26"
    status: backlog
    who: akot
    note: >
      Spawned from 0094's recommendation: the seed reads a seller's 402 without a payment first,
      so it can list an offer that no buyer can pay.
---

# Don't seed a Stellar listing whose payTo can't receive its asset

## Summary

As a buyer searching the Bazaar, I want a seeded listing to be payable, so that I don't find a
seller whose `payTo` has no trustline to the asset it asks for, which every client refuses before
signing.

## Context

- A listing cataloged after a settlement was paid, so its `payTo` could receive at that time. The
  seed (0155, `cataloger.ts` `seed`) lists a seller's Stellar offers from its unpaid 402 alone.
- With upstream's client a missing trustline, or a `payTo` that doesn't exist, stops every buyer
  before signing (0094 R-what-the-seller-sees). Such a listing is dead.
- Reading takes two ledger entries: the SAC's instance, for `CODE:ISSUER`, and the account plus
  trustline. The facilitator's `trustline.ts` already reads the SAC's name, and the SDK's
  `lookUpTrustline` does the whole check.
- The operator reads the seed's report; the seller isn't told. That is the point of 0094's
  conclusion 3: this protects buyers.

## Implementation

- In `seed`, for each Stellar `(network, payTo)` with a classic asset's SAC:
  - check that `payTo` exists and holds an authorized trustline;
  - if not, the result is `refused` with a reason of its own, such as `pay_to_cannot_receive`, and
    a detail saying which;
  - a contract `payTo`, a non-SAC token or a failed read stays as today (not refused), logged.
- Decide whether to share the SDK's check or keep one in the facilitator. The facilitator doesn't
  depend on the SDK today.
- Count the reads against the seed's request budget, or say why not.
- Out of scope: re-checking listings after cataloging (0154's quality score may use the same check).

## Acceptance Criteria

- [ ] Given a seeded seller whose Stellar `payTo` has no trustline to its classic asset, or doesn't
      exist, when the seed runs, then that offer is refused with the new reason and the report
      names it, and a test covers both
- [ ] Given a `payTo` that can receive, a contract `payTo`, or a ledger read that fails, when the
      seed runs, then the offer is seeded as today, and a test covers each
- [ ] The reason is listed where the seed's reasons are documented
