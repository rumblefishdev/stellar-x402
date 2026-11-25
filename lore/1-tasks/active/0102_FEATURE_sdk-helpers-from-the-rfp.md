---
id: "0102"
title: "Build the TypeScript SDK helpers the RFP asks for"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: ["0001"]
related_tasks: ["0101", "0041", "0092", "0136", "0140", "0132"]
tags: [sdk, priority-medium, effort-medium, dev-tools]
links: []
history:
  - date: "2026-11-03"
    status: backlog
    who: karolkow
    note: >
      The RFP requires SDK helpers and two examples, and no task built them; only an empty package
      stood for them until 0101 removes it.
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      Started. First step is the helper list per party (seller, buyer, agent), agreed with the
      owner before any package code; 0092 follows for the buyer helper's missing-trustline error.
---

# Build the TypeScript SDK helpers the RFP asks for

## Summary

The RFP asks for "SDK helpers for sellers, buyers, and agents"
(`docs/rfp/07-x402-facilitator-bazaar.md:20,121`, architecture §7).
`docs/planning/m1-epics.md:44-47` puts them outside T1. This task holds the TypeScript helpers;
the Rust seller crate is 0136 (done) and 0140. The RFP's two examples belong to 0041.

## Context

- `packages/sdk` exists, holding only the Rust crate (`packages/sdk/rust`, 0136). Per 0136's
  decision 1, the TypeScript helpers take `packages/sdk` itself or a folder next to `rust`.
- 0132 counts this task in M2's D4, "SDK helpers, TypeScript (0102, 0092)".
- Already covered elsewhere, so not to be rebuilt: the seller's discovery metadata
  (upstream's `declareDiscoveryExtension`, used in `examples/http-api`, see 0075).
- The buyer's payment logic lives in `apps/mcp-local/src/pay.ts` (limits, budget, the
  `onPaymentCreationFailure` hook); a buyer helper may move it out of the app instead of copying it.
- 0092 adds a missing-trustline error to the first buyer helper.

## Implementation

- Read the RFP's list with the owner first and write down here which helpers, for which party
  (seller, buyer, agent), and which are dropped. Too thin to start before that.
- Create the TypeScript package with its first helper.

## Acceptance Criteria

- [ ] The helper list per party is recorded here, agreed with the owner
- [ ] Every TypeScript SDK helper on that list exists, or the owner has dropped it in writing
