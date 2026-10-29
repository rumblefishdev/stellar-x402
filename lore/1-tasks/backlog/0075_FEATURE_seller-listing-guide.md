---
id: "0075"
title: "Seller guide to getting a service listed in the Bazaar"
type: FEATURE
status: backlog
related_adr: ["0008"]
related_tasks: ["0063"]
tags: [docs, bazaar, discovery, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-27"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: a listing enters only through a settled payment, so a new seller needs one
      paid call of its own to appear in the catalog.
  - date: "2026-10-28"
    status: backlog
    who: karolkow
    note: >
      Scope cut to a written guide, as the largest public catalog does; the helper command that
      pays for the seller is dropped. A no-payment check command stays a possible follow-up.
---

# Seller guide to getting a service listed in the Bazaar

## Summary

As a seller, I want a short guide that tells me how my service gets into the Bazaar and how to
check it did, so that a new service can be found without waiting for a buyer who already knows it.

## Context

- After 0063 a listing's content comes from the seller's own unpaid 402, and a settled payment only
  triggers that check (RFP 07 asks for cataloging on `PaymentPayload`; the architecture document
  rules out a separate registration process).
- The largest public x402 catalog documents the same path: the seller pays once for its own
  endpoint. The amount goes back to the seller's wallet; the facilitator pays the network fee.
- RFP 07's "seller-side helpers for discovery metadata" are covered by upstream's
  `declareDiscoveryExtension`, already used in `examples/http-api`.
- Not measured yet: whether a settle whose payer is its own `payTo` passes on Stellar. If not, the
  guide says to pay from a second account.

## Implementation

- A seller guide (`docs/` or the http-api example's README): declare the route with
  `declareDiscoveryExtension`; pay once for it with any x402 client; check
  `GET /discovery/resources?payTo=<account>`; what each listing refusal reason means and how to fix
  it (reasons from ADR 0008).
- Measure on testnet whether a self-payment settles and is cataloged; write the result into the
  guide.

## Out of scope

- A helper command that pays for the seller: dropped 2026-10-28.
- A `seller check <url>` command that tells, without paying, whether the 402 would be listed:
  possible follow-up if sellers ask.

## Acceptance Criteria

- [ ] Given the guide and a seller URL with a valid 402, when a seller follows it on testnet, then
      the listing appears
- [ ] The guide names every listing refusal reason a seller can fix, with the fix
- [ ] Whether a self-payment is cataloged is measured on testnet and stated in the guide
