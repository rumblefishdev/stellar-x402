---
id: "0134"
title: "Decide how the Bazaar search retrieves and ranks in PostgreSQL"
type: RESEARCH
status: active
owner: karolkow
milestone: 2
related_adr: ["0008", "0012", "0014"]
related_tasks: ["0120", "0135", "0013", "0154"]
tags: [bazaar, search, priority-high, effort-small, discovery]
links:
  - ../../../../docs/adr/0012-facilitator-state-store.md
  - ../../../../docs/scf/milestone-1-evidence.md
  - ../../../../docs/adr/0014-bazaar-search.md
  - notes/R-search-measurement.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan, as the first step of 0120.
  - date: "2026-11-18"
    status: active
    who: karolkow
    note: >
      Started.
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

## Premise

A fresh reviewer, given only the goal and the constraints, attacked the task on 2026-11-18.
Verdict: rethink. Each point and where it went:

- **0135's 25-resource set can't tell methods apart** (an obvious-first order already scores high
  on it). The choices here were measured on 3,000 real catalog listings and on ToolRet instead;
  0135's set only scores the result.
- **A model inside the facilitator's 512 MiB, on the `/settle` path, is a risk.** The model runs
  in its own container, with search falling back to words.
- **`pgvector` is a change no catalog size needs yet.** The owner kept the dense part because §4
  promises it; the measurement shows it carries the search (words alone 0.436, fused 0.706).
- **Ranking by volume rewards wash trading, which the facilitator pays fees for.** The quality
  score moved to its own task, 0154.
- **The consumer is an agent, so recall in the first 20 matters more than the order of the first
  10.** Recall@20 decides between methods; nDCG@10 is still reported to SCF.
- **§3's `partialResults` contradicts the spec.** The spec's meaning is kept; the difference is in
  0132.

## Acceptance Criteria

- [x] An ADR (or an amendment to ADR 0012) records the lexical part, the dense part, the embedding
      model and where it runs, the fusion, and what was rejected
- [x] Any difference from §4 of the Panel Review response is listed for the M2 evidence (0132)
- [x] The ADR says what the search does while a listing's vector or quality score is missing
      (the vector here; what a listing without a quality score gets is 0154's)
- [x] 0120 is updated to name the chosen approach

## Result

[ADR 0014](../../../../docs/adr/0014-bazaar-search.md) records the approach; the measurements
behind it, on 3,000 catalog listings and on ToolRet, are in
[R-search-measurement](notes/R-search-measurement.md), with the scripts, queries and grades in
`benchmark/`. The differences from the Panel Review response are rows in 0132's deviations table.

## Design Decisions

### From Plan

1. **Recall@20 decides between methods; nDCG@10 is still reported to SCF.** The consumer is an
   agent reading a candidate list.
2. **This task covers matching, ordering and the cursor.** The quality score and curation moved
   to 0154.
3. **Both parts, as §4 promises:** PostgreSQL full-text and a small self-hosted embedding model,
   fused with RRF. The measurement tunes them; it does not decide whether the dense part exists.
4. **Vectors in PostgreSQL with `pgvector`,** from the pgvector project's own image pinned by
   digest, not an image we build.
5. **The model in its own container, 512 MiB,** counted in ADR 0011's totals; search falls back
   to words when it is down.
6. **The model is `granite-embedding-30m-english`.** The same quality as the other small models
   on ToolRet and on our test, at the lowest query time.
7. **A listing matches only by meaning (cosine ≥ 0.60); words order the matches.** The same
   quality as any-word matching with a third of the matches.
8. **No cut before fusion:** every match is ranked and the cursor reaches the last one.
9. **A keyset cursor** (last score and listing key); a shift at a page boundary is accepted.
10. **A listing joins search once its vector is stored;** `partialResults` keeps the spec's
    meaning ("truncated"), and §3's reading is a deviation for the M2 evidence (0132).
11. **A search reads one network's store;** a search without `network` follows 0126's rule for
    `/discovery/resources`.
12. **One text per listing** from service name, tool name, URL path words, tags, description and
    parameters, read by both parts.

### Emerged

13. **Filters apply before ranking,** as the spec's filter parameters require, so a filtered query
    ranks among the listings that pass.
14. **k = 20 and meaning weighted 4,** picked from the measured grid's flat part; the first point
    tried (k = 60, 3 : 1) sat on its slope.
15. **The fields are built once by one SQL function into a stored generated column,** so the
    words part, the vector text and its hash can't disagree.
16. **The vector job takes no lock:** it writes a vector only while the listing's text hash is
    the one it embedded.
17. **Model input is cut at 512 tokens and the joined text at 2,000 characters.**
18. **While a new model's vectors are written, search answers by words alone,** so no listing
    drops out during the switch.
19. **Tuning never uses 0135's evaluation set,** which only scores the ranking.
20. **Curation-only mode, served until 0135 reaches nDCG@10 ≥ 0.75, is 0154's to define.**
21. **`bge-base-en-v1.5` rejected on quality,** not memory: tuned for it, 0.702 nDCG@10 against
    granite's 0.725, once the server's 125 GiB removed the memory reason.
