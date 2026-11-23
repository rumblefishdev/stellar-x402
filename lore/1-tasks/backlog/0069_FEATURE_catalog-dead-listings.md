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
- A listing can also keep an offer its seller no longer takes. A payment's copy carries only the
  paid offer, so 0063's `sameListing` (`packages/bazaar/src/seller.ts`) reads it as unchanged
  while that offer is still stored, and the seller isn't asked: when a seller stops taking USDC,
  buyers paying in XLM keep the USDC offer listed. Found in the PR #89 review; one way out is to
  treat a listing older than a set age as changed, so the per-listing budget still bounds checks.
- Measured 2026-11-09 with one unpaid request per URL: of the 1,513 Stellar offers in Coinbase's
  public CDP list, 1,503 answer with a valid 402; of a random 200 URLs from the whole list, about 40
  do not work (gone, no answer, or no longer paid). Once the catalog takes in URLs from other lists
  (task 0122), dead listings become common.
- Nothing ever removes a listing today. Coinbase's hosted Bazaar drops a resource after 30 days
  without a settlement (docs.cdp.coinbase.com/x402/seller/get-discovered).

## Implementation

- Decide with the owner: remove after N days without a settlement, or mark the listing and filter
  it out by default.
- Decide with the owner (moved from 0063, 2026-11-16): what a listing becomes when its seller
  check keeps failing on the seller's side — an answer over 64 KiB or later than 10 s, no 402.
  Today it stays as the seller last confirmed it, with that `lastUpdated`. Peers: Veridex compares
  the live payment terms at each refresh; openx402's MCP shows `status: stale`.
- Decide with the owner (moved from 0154, 2026-11-23): whether a listing whose seller stopped
  answering ranks lower in search, as one more factor of ADR 0014's quality factor q, and which
  check says so. Seeded listings are checked once today, so a periodic check comes first.
- Pruning runs where 0050 prunes other store rows, if that fits.

## Acceptance Criteria

- [ ] Given a listing with no settlement for the decided period, when the catalog is listed, then
      it isn't shown
- [ ] Given a listing that settles again, when it is checked, then it is shown again
- [ ] Given a seller that dropped one of its offers, when a later payment pays another offer,
      then within the decided period the listing shows only the offers the seller still answers
