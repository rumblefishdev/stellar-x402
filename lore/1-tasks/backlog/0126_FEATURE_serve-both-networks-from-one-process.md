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

## Open Questions

From 0077 (ADR 0012 lists them):

- **What `ready` reports** with a lease per network (0077 decision 9).
- **Which database holds the catalog.** `/discovery/resources` without a `network` filter lists
  both networks, with an exact `total` and an `offset` up to 1 000 000, but each network's entries
  are in its own database. Merging two queries costs `offset + limit` rows from each; one database
  for the catalog keeps a testnet reset from wiping testnet's listings.
- **Which database holds the IP rate limiter's counters.** They are counted before the request's
  network is known, and `/supported` and `/discovery/*` may carry none.

## Acceptance Criteria

- [ ] The facilitator serves `stellar:testnet` and `stellar:pubnet` from one process, each with its
      own channel pool, key and RPC endpoints, and `/supported` lists both
- [ ] A payment for a network the process doesn't serve is `invalid_network`
- [ ] One network's lease lost or database down doesn't stop `/settle` on the other
- [ ] The open questions above are decided and recorded in ADR 0012 or the spine
