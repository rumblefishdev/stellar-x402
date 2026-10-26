---
id: "0069"
title: "Drop or mark catalog listings whose seller stopped answering"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0063", "0050"]
tags: [bazaar, discovery, priority-low, effort-small]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-26"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: when a seller's page stops answering 402 or names another payTo, 0063
      leaves the listing unchanged and logs it.
---

# Drop or mark catalog listings whose seller stopped answering

## Summary

As a buyer browsing the Bazaar, I want listings of services that are gone to drop out of
`/discovery/resources`, so that the catalog shows what can still be bought.

## Context

- 0063 builds a listing from the seller's own 402. When a later check finds no 402 (a `410`, a
  timeout) or another `payTo`, it leaves the listing unchanged and logs the cause.
- Nothing ever removes a listing today. Coinbase's hosted Bazaar drops a resource after 30 days
  without a settlement (docs.cdp.coinbase.com/x402/seller/get-discovered).

## Implementation

- Decide with the owner: remove after N days without a settlement, or mark the listing and filter
  it out by default.
- Pruning runs where 0050 prunes other store rows, if that fits.

## Acceptance Criteria

- [ ] Given a listing with no settlement for the decided period, when the catalog is listed, then
      it isn't shown
- [ ] Given a listing that settles again, when it is checked, then it is shown again
