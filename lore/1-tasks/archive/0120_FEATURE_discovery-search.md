---
id: "0120"
title: "Search the Bazaar: /discovery/search with ranking"
type: FEATURE
status: completed
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
  - date: "2026-11-26"
    status: completed
    who: karolkow
    note: >
      Five PRs merged: #224 (shared query schema), #225 (search cards), #226 (search by words),
      #243 (coverage tool), #249 (search by meaning: model container, pgvector, fused ranking,
      the search-words-only alarm).
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
  pubnet. Ranking by repeated words stays a named risk with no limit of its own (ADR 0014): the
  threat model's entry names it as residual risk, not as 0154's to discount.
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

- [x] Given listings in the catalog, when a client calls `/discovery/search` with a plain-words
      query, then it gets matching listings ranked by fit, in upstream's response shape, with a
      cursor for the next page

The MCP search tool over the route, and its criteria, moved to 0137.

## Design Decisions

### Emerged

1. **Search data lives in its own table, one card per listing**: ADR 0014 put a generated words
   column and the vector on `catalog`. Adding such a column rewrites the catalog under its lock
   (5.5 s at 35,000 listings), so `catalog_search` holds the four fields, their words, and the
   vector; the catalog write and its card go in one statement (#225, ADR 0014 amended).
2. **The card's text is built in TypeScript, in `packages/bazaar`**: the listing's shape is then
   known in one language; SQL only weighs the four fields A to D. The same rules in SQL and in
   TypeScript gave 0 differences on 39,577 CDP listings.
3. **The model is our own Node server on onnxruntime-node and @huggingface/tokenizers**:
   transformers.js pulls sharp and libvips (LGPL-3.0). It runs from the facilitator's image as a
   container of its own, 768 MiB and 1 CPU, on an internal network shared only with the facilitator.
4. **The facilitator starts the model but never waits for it**: a model that can't start leaves
   search on words alone (`partialResults` true, `search-words-only` fires), and `/settle` stays up.
5. **One loop writes every vector**: it runs at start and every 30 s and embeds each card without
   a vector of its current text; a listing written meanwhile is found by its words.
6. **A fused cursor while search runs on words is a 503 with `Retry-After`**, not a 400: the client
   did nothing wrong, and the same cursor works again once the model answers.
7. **Request limits**: `limit` 20 by default, at most 100, as `/discovery/resources`; an empty
   query or one over 2,000 characters is a 400; a query looks for its first 32 distinct words;
   search shares `/discovery/*`'s per-IP budget.
