---
id: "0122"
title: "Find what interoperating with the wider x402 discovery ecosystem asks of the Bazaar"
type: RESEARCH
status: backlog
milestone: 2
related_adr: ["0008"]
related_tasks: ["0120", "0063"]
tags: [bazaar, discovery, research, priority-low, effort-small]
links:
  - ../../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: >
      An RFP requirement with no task until now; the RFP doesn't say what it means.
---

# Find what interoperating with the wider x402 discovery ecosystem asks of the Bazaar

## Summary

As the grant's reviewer, I want to know how our Bazaar works with other x402 catalogs, so that
"Interoperate with wider x402 discovery ecosystem" is met by a stated plan, not by chance.

## Context

- The RFP's Bazaar section asks to "Interoperate with wider x402 discovery ecosystem", and its
  evaluation criteria ask for "interop strategies" (`docs/rfp/07-x402-facilitator-bazaar.md`).
- Our listings already use upstream's discovery types and the spec's resources endpoint.
- Other catalogs exist: a crawl of Coinbase's on 2026-10-20 counted 26,427 listings, 638 of them
  payable on `stellar:pubnet` (not re-measured).
- Findings so far: `notes/R-public-catalog-sources.md` (2026-11-10). The network-wide
  alternative is task 0129.

## Decisions so far

| # | What is decided | From | Vs the task | Who does the same (checked) | Code | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A listing shared with other catalogs carries its route template with parameter names (`/users/:id`); our listing key keeps them erased, so one service stays one listing (task 0030, red team RT3). Measured 2026-11-12: 8 pairs that differ only by a parameter name among 1,253 route templates in the largest public catalog | owner, 2026-11-12 | beyond it; changes 0030's "shown URL = key URL" for the shared form | spec: `routeTemplate` keeps names (`specs/extensions/bazaar.md`) | | |

## Implementation

- List what interoperating could mean: the same API and listing shape, other catalogs reading
  ours, ours taking in theirs, or a shared registry.
- For each, what we already meet, what it would cost, and which the RFP's wording asks for.
- A note with the findings and a recommendation for the owner.

## Acceptance Criteria

- [ ] A note lists each meaning of interoperating, what we meet today and what each further step
      costs, with sources
- [ ] The owner picks the steps; the ones picked become tasks or join 0120
