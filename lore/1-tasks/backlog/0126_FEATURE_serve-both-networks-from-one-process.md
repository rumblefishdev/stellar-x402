---
id: "0126"
title: "Serve testnet and mainnet from one facilitator process, each network with its own pool, key, RPC endpoints and store"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0004", "0011", "0012", "0013"]
related_tasks: ["0077", "0038", "0026", "0027"]
tags: [facilitator, architecture, mainnet, priority-medium, effort-large, platform]
links:
  - ../../../docs/architecture/m1-spine.md
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-09"
    status: backlog
    who: stkrolikiewicz
    note: >
      Split from 0077 as its PR C, the code. Mainnet is out of T1 (docs/planning/m1-epics.md), and
      testnet runs on one network as today, so the code moves to milestone 2 and 0077 closes with
      its docs (PR A #79, PR B #93).
---

# Serve testnet and mainnet from one facilitator process, each network with its own pool, key, RPC endpoints and store

## Summary

0077 decided one facilitator service for both networks, the network named in each request, and
reworked the docs to say so (ADR 0011, 0004, 0012, 0013 and the spine). The code still serves one
network per process. This task makes it serve the set of networks it is configured for, each with
its own channel pool, signer, RPC endpoints and store, before mainnet joins.

## Context

- Today: one `network` in `apps/facilitator/src/config.ts` (:388), read from `NETWORK` (:521).
- What the code must match: the spine (AD-12, AD-13, AD-17, AD-18), ADR 0004's dispatch by network,
  ADR 0012's database per network, ADR 0013's socket and AppRole per network. All from 0077's PR B.
- 0077's decisions this builds on: a database per network, a lease per network (10), spend budgets
  per network (11), the per-network keys and sockets (12), `/supported` per network (13).

## Implementation

- `NETWORK` becomes the set of networks served; config, secret files and OpenBao sockets per
  network, as ADR 0011 names them (`database-url.<network>`, `rpc-urls.<network>`, …).
- One store, channel pool, signer and RPC endpoints per network inside the process; `/verify` and
  `/settle` pick them by the requirements' `network`, and a network not served is
  `invalid_network`.
- A channel lease per network; without a network's lease, `/settle` for that network isn't served.
- `/supported` lists an `exact` kind per network and each network's facilitator key.
- Spend budgets per network, in that network's store, counting only its own fee account's fees
  (0077 decision 11, AD-18).
- From 0105: `/verify` and `/settle` already read the body before they count a request and
  require an API key by `paymentRequirements.network` (`http/admit.ts`), so nothing there changes
  with two networks, but the registry (`stores.apiKeys`) and the counters it uses must become the
  request's network's. The key rule holds only while a settlement's network comes from that field
  (threat model, "Naming another network to skip the key"). Today the field is read twice: by
  `namedNetwork` from the raw body for the key rule, and from the parsed requirements by the
  checks, which refuse any network but the process's own. Once the handler picks a store and a
  signer by network, read it once and hand the same value to the key rule and the handler, so the
  two can't come apart (from the review of #185, 2026-11-13). Pubnet's compose services need one
  for the key script (`node dist/keys.js`), as `migrate-testnet` is for migrations.
- From 0105, before pubnet opens: a flood of made-up keys is unthrottled (threat model, "Requests
  without a valid key, in bulk"), and each one of the right form reads the registry. Since #185
  that read has a pool of its own (3 connections), so the flood no longer holds up the counters
  or a request without a key; keep that when each network gets its own store and pools. What is
  left: a request with a real key waits behind the flood's reads. Decide whether the edge stops
  it (0038) or a guard on refusals does, with the faults the threat model lists (from Stanisław's
  review of #185, 2026-11-13).
- From 0107, before pubnet opens (2026-11-24):
  - add `stellar:pubnet` to infra's `networks` (`infra/envs/production.json`), so pubnet gets its
    own `signer-failures` and `budget-nearing` alarms, and fire-test `budget-nearing` for `free`;
  - size the registry's pool (3 connections): every pubnet settlement now reads its account's plan
    there, inside the settle budget, so a slow read can use up the budget;
  - point the portal at pubnet's database: until then the hub's usage counts testnet's, where no
    payment has a key, and shows 0;
  - run once by hand the runbook's Logs Insights query for `spend_limit_reached` and its
    `keys plan` Docker command ("Account plans").
- From the review of #236 (0107, 2026-11-24):
  - the pruner's horizon is per network: it deletes `spend_reservations` by age alone, 62 days
    on a network that requires a key and 7 elsewhere, so a pass with testnet's horizon over
    pubnet's database would delete the month's rows and give every account its quota back
    (Stanisław). Start after 0157's `compose()` test for the keyed wiring exists;
  - take `ACCOUNT_PLANS`, `SPEND_FREE_STROOPS` and `SPEND_GLOBAL_STROOPS` from the server's `.env`
    through `${…}` in both `deploy/production/compose.yaml` and `portal.compose.yaml`: neither
    passes them today, so both services run on the defaults built into their images, and one
    value read by both keeps the facilitator and the portal on the same plans without a pull
    request (Oskar; the runbook's "Account plans" says how it is until then). Check what each
    service does with an empty value before using `${…:-}`;
  - log in the portal when a row names a plan its config lacks, as the facilitator's
    `account_plan_unknown` does: today it shows `free` silently (Oskar).

## Open Questions

From 0077 (ADR 0012 lists them):

- **What `ready` reports** with a lease per network (0077 decision 9).
- **Which database holds the catalog.** `/discovery/resources` without a `network` filter lists
  both networks, with an exact `total` and an `offset` up to 1 000 000, but each network's entries
  are in its own database. Merging two queries costs `offset + limit` rows from each; one database
  for the catalog keeps a testnet reset from wiping testnet's listings.
  `/discovery/search` (0134) takes the same rule as `/discovery/resources`: with entries in two
  databases, a search without a `network` filter ranks two candidate lists into one, and testnet
  listings would sit among mainnet's.
- **Which database holds the IP rate limiter's counters.** They are counted before the request's
  network is known, and `/supported` and `/discovery/*` may carry none.

From Oskar's review of #93:

- **One network's failed startup check: refuse the process, or only that network?** AD-12's check
  refuses the start unless every channel is right, and a schema behind the code stops the start
  (ADR 0011). With mainnet live, a deploy with testnet's migration behind would keep the whole
  process down, mainnet with it.

## Acceptance Criteria

- [ ] The facilitator serves `stellar:testnet` and `stellar:pubnet` from one process, each with its
      own channel pool, key and RPC endpoints, and `/supported` lists both
- [ ] A payment for a network the process doesn't serve is `invalid_network`
- [ ] One network's lease lost or database down doesn't stop `/settle` on the other. If the IP
      rate limiter's counters sit in one network's database, that database down stops both, so the
      answer to that question decides whether this holds
- [ ] Each network's spend budgets, the global one included, count only its own fee account's fees
- [ ] `deploy/` gives each network its own secret files, OpenBao socket mount and AppRole files
- [ ] The "until 0126" notes in ADR 0004, ADR 0011 and the spine are gone
- [ ] Once pubnet has its database, the mainnet sellers are seeded into its catalog with
      `pnpm seed` (0155 decision 6: testnet's catalog holds testnet's listings only)
- [ ] The open questions above are decided and recorded in ADR 0012 or the spine
