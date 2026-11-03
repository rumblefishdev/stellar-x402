---
id: "0102"
title: "Build the SDK helpers the RFP asks for"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0001"]
related_tasks: ["0101", "0041", "0092"]
tags: [sdk, priority-medium, effort-medium]
links: []
history:
  - date: "2026-11-03"
    status: backlog
    who: karolkow
    note: >
      The RFP requires SDK helpers and two examples, and no task built them; only an empty package
      stood for them until 0101 removes it.
---

# Build the SDK helpers the RFP asks for

## Summary

The RFP (`docs/rfp/07-x402-facilitator-bazaar.md:20,121,124`, architecture §7) requires SDK helpers
and examples. `docs/planning/m1-epics.md:40-42` puts them outside T1, and no task builds them.

## Implementation

- Create `packages/sdk` (ADR 0001) when its first helper exists.
- Read the RFP's list before planning: which helpers, for which party, and whether `examples/http-api`
  already covers one of the two examples.

## Acceptance Criteria

- [ ] Every SDK helper and example the RFP names exists, or the owner has dropped it in writing
