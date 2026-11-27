---
id: "0154"
title: "Quality score and curation for the Bazaar search ranking"
type: FEATURE
status: completed
owner: karolkow
milestone: 2
related_adr: ["0007", "0008", "0012", "0014"]
related_tasks: ["0134", "0120", "0135", "0069", "0070"]
tags: [bazaar, search, ranking, priority-high, effort-medium, discovery]
links:
  - ../../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
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
  - date: "2026-11-27"
    status: completed
    who: karolkow
    note: >
      Closed after #270. Four PRs: the ADR 0014 amendment (#229, #231), each payment's listing on
      its settlement claim (#230), and q inside both search queries with the card's host column,
      migration 0021 (#270). Facilitator tests of the touched files 348 passed, bazaar 149.
      44 decisions; 3 known gaps named in ADR 0014 (price change, per-request price, muxed payTo).
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

Answered by the 2026-11-23 amendment of ADR 0014: its Decision, "Quality score" to "When the ranking
is served", and the per-host cap under Alternatives. The measurements are in
[R-quality-measurement](notes/R-quality-measurement.md).

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

- [x] An ADR (or an amendment to 0134's ADR) records the score's inputs, their weights, how fake
      payers are bounded, and the curation rule (ADR 0014, "Quality score"; curation is 0070's)
- [x] Given two listings that match a query equally, one with distinct paying wallets and one with
      none, when an agent searches, then the one with paying wallets ranks first (store contract
      tests for words and fused, and the route test in `search.test.ts`)
- [x] Given a listing whose only payer is its own `payTo`, when the score is computed, then those
      payments do not count (a muxed `payTo` is the named exception, ADR 0014)
- [x] Any difference from the proposal's §4.3 is listed for the M2 evidence (0132, D1 rows)

## Implementation Notes

- **#229, #231:** ADR 0014 records q = (1 + 0.2 · p / (p + 2)) × 0.9 on a tunnel host × 0.9 with an
  empty description, the 30-day window, and how fake payers are bounded.
- **#230:** `/settle` reads the listing's method and URL from the payment's `extensions.bazaar`
  copy and stores them on the settlement claim (`settlements.listing_method`, `listing_url`).
- **#270:** both search queries in `postgres-catalog.ts` find the matches first (`m`,
  materialized), count each match's distinct payers from `settlements` (`paid`), then rank by
  rank × q; the keyset cursor runs on that score. The card's `host` column (migration
  `0021_catalog_search_host`) comes from the WHATWG URL parser in `packages/bazaar`
  `searchFields`. The route passes the app clock as `catalog.search(query, now)`.
- Measurements are in [R-quality-measurement](notes/R-quality-measurement.md): words alone with
  25,000 payments 324–498 → 578–863 ms; fused with every listing matched 1.1–1.3 → 2.1–4.3 s.

## Issues Encountered

- **Counting payers before the matches** made the planner misestimate the matches and pick a
  nested loop over all listings (1.2–2.4 s); counting after a materialized match list fixed it.
- **Timing tests flaked on CI** three times during #270 (`settle.test.ts`, `refusals.test.ts`),
  none in code #270 touches; reruns passed. Same class as 0074.
- **Postgres tests need pgvector:** the default test database lacks the `vector` extension, so the
  search tests run against a pgvector container (`TEST_DATABASE_URL`).

## Design Decisions

### From Plan

1. **q is a bounded multiplier of relevance.** final = rank × q; the payer bonus 0.2 · p / (p + 2)
   saturates, so q is at most 1.2. Given equal relevance, paid listings rank first.
2. **Computed in SQL at each search**, from the stored settlements, with no payer table and no
   6-hour recompute; the difference is listed for 0132.
3. **Buyer reach counts distinct paying wallets** settled by this facilitator, per network, the
   same rule on testnet and pubnet; volume is not used, and recency is the 30-day window.
4. **Only a seller paying its own `payTo` is left out**; wallets the seller funded still count,
   because half of real pubnet payers were funded by the payee or its funder.
5. **Penalties:** × 0.9 on a tunnel host (13 named services, a host or a name under one), × 0.9
   for an empty or spaces-only description; they multiply (0.81). Shared hosting gets none.
6. **Payments link to listings by two columns on `settlements`**, written at the claim; payer,
   network, `payTo`, asset and amount are read from the settlement row. Rows are kept; the count
   filters the last 30 days by `created_at`. Nothing is backfilled.
7. **The words-only fallback keeps q.** No curation-only mode; curation (a seller proving its
   `payTo` with `stellar.toml`) and its bonus are 0070's. No per-host cap on a page yet.

### Emerged

8. **A payment counts only on terms equal to a stored offer** (scheme, network, `payTo`, asset,
   amount), because `/settle` takes terms from any caller and one stroop would otherwise buy a
   payer.
9. **Payers are counted per listing**, inside the search SQL, after the matches are found.
10. **The host is parsed in TypeScript** when the card is written and stored on the card, not cut
    out of the URL in SQL. A card the release before writes during a deploy keeps `host = ''` and
    no penalty until the next start's rewrite.
11. **The window is inclusive and open-ended:** a payment exactly 30 days old counts, and one
    dated after `now` counts too. The route reads the clock and passes it as a second argument.
12. **Nothing is frozen in the cursor:** a listing may move between pages when a payment lands or
    leaves the window.
13. **Known gaps, named in ADR 0014, no code:** after a price change old payments stop counting
    until the old offer returns; a listing with a per-request price never gains payers; a seller
    paying a muxed `payTo` from its base account counts.

## Future Work

Not created as tasks; each waits for the owner's decision:

- Compare a muxed `payTo` by its base account (a base-account column on the card).
- Rethink how a payment counts for a listing: a value floor in place of offer equality would fix
  the price-change and per-request-price gaps.
- Watch words-only search time as settlements grow: rows are never pruned.
- Measure one host's share of the top 10 once ranking runs (decision 7).
