---
id: "0041"
title: "Two end-to-end example integrations"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0037"]
tags: [examples, docs, priority-medium, effort-medium]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-10-13"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0037: its paid test endpoint became examples/http-api, a test seller and only
      the seed of Example 1, so the RFP deliverable gets its own task.
---

# Two end-to-end example integrations

## Summary

The RFP lists "Two end-to-end example integrations" among the expected deliverables
(`docs/rfp/07-x402-facilitator-bazaar.md`). They are outside T1
(`docs/planning/m1-epics.md`, "Out of T1"). No task or owner covers them yet.

## Context

- `examples/http-api` (0037, PR #25) is a **test seller**: one paid route, `GET /weather`, with a
  fixed answer and a Bazaar declaration, paid by the MCP CLI's end-to-end run. It has no buyer
  side and serves no real data. It is the seller half of a future Example 1, not Example 1.
- Today it settles through the public x402.org facilitator, which has no catalog
  (`/discovery/resources` answers 404, measured 2026-10-13).

## To define

- What each example shows end to end: seller, buyer (SDK helpers or an agent through the MCP
  server), facilitator and catalog.
- The buyer side of Example 1, and what the second example is (for example `upto` metered usage,
  after 0015).
- Which facilitator and catalog the examples run against: ours (0009/0026, 0031/0032) or the
  public testnet ones.
- A seller run on `localhost` puts a `localhost` resource URL into its 402. Since 0053 a testnet
  catalog lists it as sent (ADR 0008: SSRF is checked by whoever fetches), so an example run
  against a shared catalog leaves an entry other agents can't reach; point the README at that.
  Pubnet refuses it (0054): the payment settles, the listing is dropped.

## Acceptance Criteria

- [ ] Two examples, each run end to end on testnet with the settled transaction hashes recorded
- [ ] Each has a README a developer can follow from a clean checkout
