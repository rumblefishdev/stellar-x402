---
id: "0155"
title: "Seed the Stellar Bazaar once from the sellers' own files, without other catalogs"
type: FEATURE
status: completed
owner: karolkow
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
  - date: "2026-11-20"
    status: active
    who: karolkow
    note: >
      Grilling done (decisions 1-15); four PRs: extract the seller check, discovery for both
      networks, the robot's User-Agent, then the seed command.
  - date: "2026-11-24"
    status: completed
    who: karolkow
    note: >
      PRs #214, #215, #216 and #217 merged, with robots.txt following in the seed. All seven
      criteria met; 133 tests of the seed, the seller check and discovery pass on develop.
      ADR 0008 names the seed as the second trigger. The run on the deployed facilitator is an
      operator step, not part of this task. No follow-up work.
---

# Seed the Stellar Bazaar once from the sellers' own files, without other catalogs

## Summary

As an agent searching the Bazaar, I want to find the Stellar sellers that already exist, so that
search answers from the first day instead of after each seller's first payment through us.
Every listing is read **directly from the seller**: its own `/.well-known/x402` file and its own
unpaid 402. No listing, field or ranking is taken from another x402 catalog, and the catalog
must not look like a copy of one.

## Premise

A fresh review (2026-11-20) attacked the task from its goal and the code. Verdict: the goal holds,
but the task as first written could not run and was larger than needed.

- It could not run: every seeded seller is on mainnet, and the facilitator serves testnet only and
  refuses to start on mainnet (`apps/facilitator/src/config.ts:373-376`); discovery returns only
  the network it settles on (`apps/facilitator/src/http/discovery.ts:87-104`). Put to the owner:
  one catalog for both networks (decision 6).
- Simpler: a seed is not a path of its own but one more trigger of the seller check a payment
  already starts, so a seeded listing passes the same gates.
- Deleted or deferred: removal on request (decision 7) and a mark for listings not yet paid
  through us (decision 14).
- Changed in the code, not asked: `catalog.ledger` and `catalog_attempts.payer` allow no value, a
  seeded check is paced below the per-host budget, and a seller's file is read only for its own
  host.

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
| 2 | Listings come only from the seller's own `/.well-known/x402` and its unpaid 402, through the same seller check a settlement triggers; no other catalog is read. The seed keeps its own pace (decision 12) instead of the per-host check budget, since it already asks more slowly |  owner, 2026-11-19 | matches | upstream proposal PR #2646 (`/.well-known/x402`) | | |
| 3 | Host names come from the list kept outside the repo. The seed reads each host's `robots.txt` (RFC 9309) and skips every URL it disallows for our robot, the seller's file included, named in the report with the reason `robots`; a 4xx means no rules, any other non-200 answer stops the host | owner, 2026-11-20; changed by owner 2026-11-23 | matches: the task honored `robots.txt` | RFC 9309 §2.3.1.3–2.3.1.4 | `apps/facilitator/src/catalog/seed.ts` `readRobots` | `apps/facilitator/test/seed.test.ts` robots tests |
| 4 | One run now; a periodic refresh is a later decision | owner, 2026-11-19 | matches | no standard | | |
| 5 | Only free checks: the facilitator never pays for a test call | owner, 2026-11-19 | matches | no standard | | |
| 6 | One catalog holds both networks' listings, each row with its network; the seed runs once now for mainnet and testnet sellers alike, although the facilitator settles only on testnet | owner, 2026-11-20 | beyond it; settles half of the point ADR 0012 left to 0126 (`docs/adr/0012-facilitator-state-store.md:65-70`): one table for both networks, while which database holds it stays with 0126 | no standard; the bazaar spec leaves storage to the implementation (`specs/extensions/bazaar.md`) | | |
| 7 | No removal mechanism until the first seller asks to be removed | owner, 2026-11-20 | changes it: the task asked for removal on request | no standard | | |
| 8 | Every request to a seller names our robot: `User-Agent: stellar-bazaar/1 (+<docs URL>)`, so a seller can tell it apart and block it by name; the name has no digits, as RFC 9309 §2.2.1 asks of a product token | owner, 2026-11-20; name changed by owner 2026-11-23 | beyond it | RFC 9309 §2.2.1 product token | | |
| 9 | Only resource URLs on the host that serves the file are asked; every other entry is skipped and named in the report with its reason (the AC asks for every refused URL) | agent, then owner 2026-11-20 | beyond it | no standard | | |
| 10 | One request per URL, by the file's method or GET: its 402 is the check's answer for every Stellar account it names. The seller is asked once more only when the 402 declares another method or an MCP tool (measured: 103 of 784 listings in a sample declare another method) | agent, then owner 2026-11-20 | beyond it | upstream: no standard | | |
| 11 | The seller's file is read up to 512 KiB, twice the largest measured (219,455 B) | agent | beyond it | no standard | | |
| 12 | The seed asks each host more slowly than the 30-a-minute check budget, so checks after real payments keep their share; the run report lists every `payTo` seen on more than one host | agent | beyond it | no standard | | |
| 13 | The seed is an operator command, `pnpm seed <hosts file>`, like `pnpm keys`; the hosts file is read from the path given and stays outside git | owner, 2026-11-20 | matches | no standard | | |
| 14 | A seeded listing carries no mark of its own; whether anyone paid through us comes from settlements, in the ranking of task 0154 | owner, 2026-11-20 | matches | the bazaar spec has no such field (`specs/extensions/bazaar.md`) | | |
| 15 | One failing resource never stops the rest: each URL is asked on its own, a host whose file fails never stops the other hosts, and every failure is a line in the run report with its reason | owner, 2026-11-20 | beyond it | no standard | | |

## Implementation

- Amend ADR 0008: seeded listings and what proves them without our payment. Amend ADR 0012 and
  ADR 0014: the catalog holds both networks, and discovery filters by network instead of refusing
  the one it doesn't settle on (`apps/facilitator/src/http/discovery.ts:87-104`).
- Run the seed: for each host, read its `/.well-known/x402`, then send each resource through the
  existing seller check (`apps/facilitator/src/catalog/seller-check.ts`), so a seeded listing
  passes the same gates as one from a settlement.
- Name our robot in the `User-Agent` of every request the facilitator's seller check sends
  (`apps/facilitator/src/catalog/seller-check.ts`); the payer's local MCP server, which shares
  `packages/seller-fetch`, keeps its own requests unnamed.
- `catalog.ledger` and `catalog_attempts.payer` allow no value, since a seeded listing has no
  settlement (`apps/facilitator/src/adapters/postgres-schema.ts`).

## Acceptance Criteria

- [x] ADR 0008 is amended for seeded listings (`docs/adr/0008-bazaar-catalog-integrity.md`)
- [x] Given the host list, when the seed runs, then every listing it adds comes from the seller's
      own file and its 402, and passes the same gates as a listing from a settlement
      (`apps/facilitator/test/catalog-seed.test.ts`)
- [x] No request goes to another x402 catalog during the seed: only the listed hosts and URLs on
      their own host are asked (`apps/facilitator/test/seed.test.ts`)
- [x] Every request to a seller carries the `stellar-bazaar` User-Agent
      (`apps/facilitator/test/cataloger.test.ts`)
- [x] Discovery lists both networks' listings, and `?network=` narrows them to one
      (`apps/facilitator/test/discovery.test.ts`)
- [x] Given a host where some resources fail, when the seed runs, then its other resources are
      still listed and each failure is reported with its reason (`apps/facilitator/test/seed.test.ts`)
- [x] The run reports listings added, hosts and `payTo` accounts, and every refused URL with its
      reason (`apps/facilitator/test/seed.test.ts`; a real run on six hosts in PR #217)

## Out of scope

- Removing a seller on request: built when the first seller asks (decision 7).
- A periodic refresh of seeded listings (decision 4).
