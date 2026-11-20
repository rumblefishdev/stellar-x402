---
id: "0155"
title: "Seed the Stellar Bazaar once from the sellers' own files, without other catalogs"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0008"]
related_tasks: ["0134", "0130", "0154", "0070", "0122"]
tags: [bazaar, discovery, priority-medium, effort-medium]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-11-20"
    status: backlog
    who: karolkow
    note: >
      Out of 0134's search work: an empty catalog has nothing to search. The catalog takes
      every reachable Stellar seller, read directly from the sellers, not from other catalogs.
---

# Seed the Stellar Bazaar once from the sellers' own files, without other catalogs

## Summary

As an agent searching the Bazaar, I want to find the Stellar sellers that already exist, so that
search answers from the first day instead of after each seller's first payment through us.
Every listing is read **directly from the seller**: its own `/.well-known/x402` file and its own
unpaid 402. No listing, field or ranking is taken from another x402 catalog, and the catalog
must not look like a copy of one.

## Context

- ADR 0008 lists a seller only after its first paid call through us and indexes nothing else
  (`docs/adr/0008-bazaar-catalog-integrity.md:31-32`). Seeding changes that rule, so the ADR
  needs an amendment: a payment through us becomes one more signal, not the condition.
- Measured 2026-11-19 (all hosts, no sampling): 32 of 35 known Stellar mainnet seller hosts
  publish `/.well-known/x402`. Their files, passed through our seller check, give 2,187
  listings from 24 hosts and 12 `payTo` accounts.
- The host names come from a list of 35 hosts kept outside the repo. Its origin is unknown.
  Only the host names are used: every listing's content comes from the seller itself.
- A generic web search without catalogs found 1 of the 35 hosts (measured 2026-11-20), so the
  host list is what makes the seed possible today.
- `/.well-known/x402` is not in the x402 spec yet: upstream has an open proposal
  (x402-foundation/x402 PR #2646, "for discussion", last updated 2026-07-03). Its shape may
  change.
- One malformed offer for another network makes `@x402/core` refuse a whole 402 (83 listings);
  per-offer validation is decided in task 0130.

## Decisions so far

| # | What is decided | From | Vs the task | Who does the same (checked) | Code | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | The catalog takes every reachable Stellar seller; a payment through us is one more signal, not the condition | owner, 2026-11-19 | matches | no standard | | |
| 2 | Listings come only from the seller's own `/.well-known/x402` and its unpaid 402, through the same seller check a settlement triggers; no other catalog is read | owner, 2026-11-19 | matches | upstream proposal PR #2646 (`/.well-known/x402`) | | |
| 3 | Host names come from the list kept outside the repo; the seller's `robots.txt` is honored, and a seller is removed on request | owner, 2026-11-20 | matches | no standard | | |
| 4 | One run now; a periodic refresh is a later decision | owner, 2026-11-19 | matches | no standard | | |
| 5 | Only free checks: the facilitator never pays for a test call | owner, 2026-11-19 | matches | no standard | | |

## Implementation

- Amend ADR 0008: seeded listings, what proves them without our payment, removal on request.
- Run the seed: for each host, read its `/.well-known/x402`, then send each resource through the
  existing seller check (`apps/facilitator/src/catalog/seller-check.ts`), so a seeded listing
  passes the same gates as one from a settlement.
- Honor `robots.txt` before the first request to a host.
- Decide in a grilling before code: script or endpoint, a mark for listings not yet paid through
  us, and where the host list lives at run time.

## Acceptance Criteria

- [ ] ADR 0008 is amended for seeded listings
- [ ] Given the host list, when the seed runs, then every listing it adds comes from the seller's
      own file and its 402, and passes the same gates as a listing from a settlement
- [ ] No request goes to another x402 catalog during the seed
- [ ] A host whose `robots.txt` disallows us gets no listing
- [ ] A seller can be removed from the catalog on request
- [ ] The run reports listings added, hosts and `payTo` accounts, and every refused URL with its
      reason
