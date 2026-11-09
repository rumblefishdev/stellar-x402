---
id: "0120"
title: "Search the Bazaar: /discovery/search with ranking, and a search tool in the MCP server"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0008", "0012"]
related_tasks: ["0029", "0063"]
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
---

# Search the Bazaar: `/discovery/search` with ranking, and a search tool in the MCP server

## Summary

As an agent, I want to describe in plain words the service I need and get the Bazaar's listings
ranked by fit, so that I can find a paid resource without knowing its seller or URL.

## Context

- The RFP asks for `GET /discovery/search` "with natural language query and cursor pagination",
  "search with ranking" as a deliverable, and an MCP server "enabling agents to search the Stellar
  Bazaar" (`docs/rfp/07-x402-facilitator-bazaar.md`).
- `docs/planning/m1-epics.md` puts `/discovery/search` and ranking out of Tranche 1; the spine
  defers them to "later tranches" (`m1-spine.md`, Deferred).
- Upstream `@x402/extensions` 2.28 types the request as `SearchDiscoveryResourcesParams`, with a
  natural-language query.
- ADR 0012 keeps search in the same PostgreSQL: full-text, `pg_trgm`, `pgvector`.
- 0029 notes that upstream's e2e Bazaar check calls `/discovery/search`.

## Implementation

- Settle the design with the owner first: ranking signals, keyword and fuzzy search first or
  vectors, cursor shape, what an empty query returns.
- The route, its port method and its PostgreSQL adapter.
- The MCP server's search tool over the route.

## Acceptance Criteria

- [ ] Given listings in the catalog, when a client calls `/discovery/search` with a plain-words
      query, then it gets matching listings ranked by fit, in upstream's response shape, with a
      cursor for the next page
- [ ] Given the MCP server, when an agent calls its search tool, then it gets the same results
