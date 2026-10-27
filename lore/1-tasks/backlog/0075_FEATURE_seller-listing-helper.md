---
id: "0075"
title: "Seller helper that gets a service listed in the Bazaar"
type: FEATURE
status: backlog
related_adr: ["0008"]
related_tasks: ["0063"]
tags: [sdk, bazaar, discovery, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-27"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: a listing enters only through a settled payment, so a new seller needs one
      paid call of its own to appear in the catalog.
---

# Seller helper that gets a service listed in the Bazaar

## Summary

As a seller, I want one command that makes the first paid call to my own endpoint through the
facilitator and tells me whether my listing appeared, so that a new service can be found without
waiting for a buyer who already knows it.

## Context

- After 0063 a listing's content comes from the seller's own unpaid 402, and a settled payment only
  triggers that check (RFP 07 asks for cataloging on `PaymentPayload`; the architecture document
  rules out a separate registration process). RFP 07 also asks for seller-side helpers for
  discovery metadata.
- `packages/sdk/src/seller.ts` is a placeholder today.
- The helper can only name a reason the facilitator exposes. 0063 keeps every listing attempt with
  its reason in `catalog_attempts`, so a per-resource status endpoint over it (resource, listed,
  last outcome and reason) would give the seller the reason without a payment. Not designed yet.

## Implementation

- A helper (CLI or `packages/sdk/seller` function) that: fetches the seller's URL unpaid and checks
  the 402 carries a valid `bazaar` extension; pays the smallest offer with a key the seller
  provides; then reads `/discovery/resources` until the listing appears or a timeout, and prints
  the reason when it does not.

## Acceptance Criteria

- [ ] Given a seller URL with a valid 402, when the helper runs on testnet, then the listing appears
      and the helper says so
- [ ] Given a seller URL whose 402 is not usable, when the helper runs, then it pays nothing and
      names the reason
