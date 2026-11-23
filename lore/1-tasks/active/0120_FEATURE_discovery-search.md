---
id: "0120"
title: "Search the Bazaar: /discovery/search with ranking"
type: FEATURE
status: active
owner: karolkow
milestone: 2
related_adr: ["0008", "0012", "0014"]
related_tasks: ["0029", "0063", "0137", "0134", "0135", "0154", "0155"]
tags: [bazaar, discovery, mcp, priority-medium, effort-large]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: >
      An RFP requirement with no task until now: the M1 plan leaves search out of Tranche 1, and
      no later task held it.
  - date: "2026-11-19"
    status: backlog
    who: karolkow
    note: >
      0134 chose the approach (ADR 0014); the questions left here are listed under
      Implementation.
  - date: "2026-11-23"
    status: active
    who: karolkow
    note: >
      Work starts. The open questions are settled; the first PR serves search by words, the second
      adds meaning and the model's container.
---

# Search the Bazaar: `/discovery/search` with ranking

## Summary

As an agent, I want to describe in plain words the service I need and get the Bazaar's listings
ranked by fit, so that I can find a paid resource without knowing its seller or URL.

## Context

- The RFP asks for `GET /discovery/search` "with natural language query and cursor pagination",
  "search with ranking" as a deliverable, and an MCP server "enabling agents to search the Stellar
  Bazaar" (`docs/rfp/07-x402-facilitator-bazaar.md`).
- `docs/planning/m1-epics.md` puts `/discovery/search` and ranking out of Tranche 1; the spine
  defers them to "later tranches" (`m1-spine.md`, Deferred).
- Upstream `@x402/extensions` 2.31.0 types the request as `SearchDiscoveryResourcesParams`, with a
  natural-language query.
- [ADR 0014](../../../docs/adr/0014-bazaar-search.md) (task 0134) chose the approach: words and
  meaning in PostgreSQL, fused by rank, the model in its own container. The quality score and
  curation are 0154's: ADR 0014 multiplies the rank by a quality factor q, which 0154's second PR
  adds to this route's query once it merges, and 0135's run decides when search is offered on
  pubnet.
- 0029 notes that upstream's e2e Bazaar check calls `/discovery/search`.

## Implementation

- Build what ADR 0014 decides. Settle with the owner first what it leaves open: what an empty
  query returns, the largest `limit` served, the longest query accepted, and whether search gets a
  rate budget of its own beside `/discovery/*`'s per-IP limit (ADR 0007).
- Pick the ONNX Runtime library for the model's container (no LGPL dependency), with its thread
  count set to the container's CPU quota. Measure on the server its memory, the facilitator's
  timeout for it and pgvector's exact scan (ADR 0014).
- The model container's deploy path: its image in the deploy scripts, a systemd unit and a
  healthcheck like the other services, and a place on an internal network (ADR 0011).
- A threat-model entry for search: ranking by repeated words, load on the model container.
- The route, its port method and its PostgreSQL adapter.
- Agree the route's request and response types first: 0137 builds the MCP search tool on them.

## Acceptance Criteria

- [ ] Given listings in the catalog, when a client calls `/discovery/search` with a plain-words
      query, then it gets matching listings ranked by fit, in upstream's response shape, with a
      cursor for the next page

The MCP search tool over the route, and its criteria, moved to 0137.
