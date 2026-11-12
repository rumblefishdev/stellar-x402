---
id: "0134"
title: "Decide how the Bazaar search retrieves and ranks in PostgreSQL"
type: RESEARCH
status: backlog
milestone: 2
related_adr: ["0008", "0012"]
related_tasks: ["0120", "0135", "0013"]
tags: [bazaar, search, priority-high, effort-small, discovery]
links:
  - ../../../../docs/adr/0012-facilitator-state-store.md
  - ../../../../docs/scf/milestone-1-evidence.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan, as the first step of 0120.
---

# Decide how the Bazaar search retrieves and ranks in PostgreSQL

## Summary

As the team building `/discovery/search` (0120), we want the retrieval approach chosen and written
down before the ranking code, so the search is built once.

## Context

- The Panel Review response (§4) names the approach: hybrid lexical and dense retrieval fused with
  Reciprocal Rank Fusion, a quality score recomputed on a 6-hour cycle, a curation bump, and a
  self-hosted embedding model so no external inference API is on the request path. It named
  ClickHouse as the store.
- The store is decided: all facilitator state, the catalog included, is in PostgreSQL (ADR 0012),
  and the M1 evidence already told SCF that Tranche #2's search and ranking are planned on it
  (`docs/scf/milestone-1-evidence.md`, "Refinements against the proposal").
- Open is how the promised approach is done in PostgreSQL:
  - the lexical part (full-text search, trigrams, or our own token table);
  - the dense part: where vectors are stored and compared, which model makes them, and where
    that model runs on a server shared with other services (ADR 0011);
  - when a listing's vector and quality score are computed, and what `partialResults` reports
    meanwhile;
  - what the cursor encodes when the ranked set shifts between requests.

## Questions

- Which PostgreSQL features carry the lexical and the dense part, and what do they need installed?
- Which embedding model, how large, and where does it run?
- What is the fallback if the dense part can't run in production: lexical plus curation only?

## Acceptance Criteria

- [ ] An ADR (or an amendment to ADR 0012) records the lexical part, the dense part, the embedding
      model and where it runs, the fusion, and what was rejected
- [ ] Any difference from §4 of the Panel Review response is listed for the M2 evidence (0132)
- [ ] The ADR says what the search does while a listing's vector or quality score is missing
- [ ] 0120 is updated to name the chosen approach
