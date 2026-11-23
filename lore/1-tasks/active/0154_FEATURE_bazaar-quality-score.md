---
id: "0154"
title: "Quality score and curation for the Bazaar search ranking"
type: FEATURE
status: active
owner: karolkow
milestone: 2
related_adr: ["0007", "0008", "0012"]
related_tasks: ["0134", "0120", "0135", "0069", "0070"]
tags: [bazaar, search, ranking, priority-high, effort-medium, discovery]
links:
  - ../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
history:
  - date: "2026-11-18"
    status: backlog
    who: karolkow
    note: >
      Split from 0134: matching the query text and the quality score need different data and
      carry different risks, so each is designed and checked on its own.
  - date: "2026-11-23"
    status: active
    who: karolkow
    note: "Work starts: the design is settled, the ADR 0014 amendment comes first."
---

# Quality score and curation for the Bazaar search ranking

## Summary

As an agent searching the Bazaar, I want listings that real buyers use to rank above listings
nobody pays for, so the first results are services that work. The search's text matching (0134)
picks the listings that fit a query; this task orders them by a quality score and a curation bump.

## Context

- The proposal ranks on three inputs: relevance, an objective quality score (buyer reach in a
  trailing window, transaction volume, recency, metadata completeness, a hosting penalty for
  shared or tunnelling hosts) and an optional curation boost; new listings are not hidden for
  lack of history but get no quality boost until usage accumulates
  (`docs/rfp/x402-facilitator-bazaar-technical-architecture.md:154-170`). The approved tranche
  plan adds a 6-hour recompute cycle.
- A settlement row has no listing key (`apps/facilitator/src/adapters/postgres-schema.ts`), so
  buyer reach per listing needs a link from settlements to listings.
- Buyer counts can be faked: a seller can pay itself from many new accounts, testnet accounts are
  free, and the facilitator pays each settlement's network fee (ADR 0007 names self-payments as a
  residual risk).
- Concentration is real: on 2026-11-18, 93% of the 1,637 Stellar listings in the Coinbase CDP
  catalog sat on 10 hosts, 57.5% on `workers.dev`.
- Curation needs health checks of listings, which 0069 (dead listings) and 0070 (verified seller)
  cover in part.

## Questions

- Which settlements count toward buyer reach and volume, and how a seller paying itself is left out?
- Is the score kept apart per network, or off on testnet?
- How a listing's settlements are linked to it, and how often the score is recomputed?
- What makes a listing curated, and who decides it?
- What curation-only mode serves for a query: which listings, in what order, with what cursor.
  Search serves it until 0135's run reaches nDCG@10 ≥ 0.75 (ADR 0014, §4 of the Panel Review
  response).
- Is a results page capped per host, so one seller's many listings can't fill it? On 2026-11-18
  the largest host held 586 of the 1,637 Stellar listings in the CDP catalog.

## Acceptance Criteria

- [ ] An ADR (or an amendment to 0134's ADR) records the score's inputs, their weights, how faked
      buyers are left out, and the curation rule
- [ ] Given two matching listings, one with distinct paying buyers and one with none, when an agent
      searches, then the one with buyers ranks first
- [ ] Given a listing whose only buyers are its own `payTo` or accounts it funded, when the score
      is computed, then those settlements do not count
- [ ] Any difference from the proposal's §4.3 is listed for the M2 evidence (0132)
