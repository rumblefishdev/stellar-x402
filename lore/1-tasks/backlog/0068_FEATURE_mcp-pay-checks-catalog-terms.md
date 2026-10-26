---
id: "0068"
title: "Refuse a paid call when the seller asks more than its catalog listing or names another payTo"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0063", "0037"]
tags: [mcp, bazaar, security, priority-medium, effort-small]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-26"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: the catalog will match the seller's 402 when an entry is written, but a
      seller can change its 402 afterwards.
---

# Refuse a paid call when the seller asks more than its catalog listing or names another payTo

## Summary

As a buyer's agent, I want `call_paid_http` to refuse a payment when the seller's live 402 asks
more than the Bazaar listing the agent chose, or names a different `payTo`, so that a listing
can't lure an agent into paying a price it never saw.

## Context

- `call_paid_http` pays the live 402, never the catalog (`packages/mcp/src/server.ts`), within
  the per-call limit and the daily budget per asset (`packages/mcp/src/pay.ts:125`, `:152`).
  Nothing compares the live terms with the listing.
- 0063 makes the facilitator write a listing only when the payment's echo equals the seller's own
  402. The seller can still change its 402 after the listing is written.
- Upstream's `x402Client` caps the amount (spend controls, "$1" by default) and offers
  `onBeforePaymentCreation` hooks; it doesn't compare against a catalog
  (`typescript/packages/core/src/client/x402Client.ts:155-185` at `af6665b`).

## Implementation

- Find the listing for the called URL and method. 0037 learned that a lookup by URL must not scan
  the whole catalog: decide how the listing reaches the call (the agent passes it, or a keyed
  lookup).
- Before signing: refuse when the live `payTo` differs from the listing's, or when the live amount
  for the same scheme, network and asset is above the listed one. A lower price passes.
- A call with no listing keeps today's behaviour, or is refused: decide with the owner.

## Acceptance Criteria

- [ ] Given a listing at price P, when the live 402 asks more than P in the same asset, then
      nothing is signed and the tool returns an error code naming the change
- [ ] Given a listing with payTo S, when the live 402 names another payTo, then nothing is signed
- [ ] Given a live price at or below the listing's, when the agent calls, then it pays as today
