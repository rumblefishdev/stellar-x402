---
id: "0077"
title: "Run one facilitator service for both networks, the network chosen per request"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011", "0012", "0013", "0004"]
related_tasks: ["0076", "0026", "0027", "0036", "0038"]
tags: [facilitator, deploy, architecture, priority-medium, effort-large, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-28"
    status: backlog
    who: stkrolikiewicz
    note: >
      From 0076 (PR #75, Oskar's review): one hostname means one facilitator service for both
      networks, with the client naming the network in the request, not a service per network.
      0076 records the decision; this task reworks the docs and the code that assume one
      process per network.
  - date: "2026-10-28"
    status: backlog
    who: stkrolikiewicz
    note: "Decided: a database per network."
---

# Run one facilitator service for both networks, the network chosen per request

## Summary

The 2026-10-26 daily with Marek settled on one hostname, `x402-facilitator.sorobanscan.com`, and
one facilitator service, `facilitator`, for testnet and mainnet. The client names the network in
the request (`network` in the payment requirements: `stellar:testnet` or `stellar:pubnet`), and
the facilitator settles through that network's channel pool, key and RPC endpoints. There is no
testnet/mainnet service split; a staging/production split may come later. Today the docs and the
code assume one process per network. This task reworks both.

## Context

- 0076 records the decision in ADR 0011's Network and URL; the rest of the ADR still describes one
  process per network.
- Measured on 2026-10-28: ADR 0011 has 57 lines naming a network in 9 of its sections, about
  150–200 of its 662 lines to rework.
- Code: one network per process, `NETWORK` in `apps/facilitator/src/config.ts:89` with its
  refinements (:217–271), 10 uses in `main.ts`.

## Implementation

- **ADR 0011:** a revision, as 0039's was.
  - Context (:24, :47–48): one process for both networks, memory totals.
  - Platform and containers (:56–90): directories, containers, limits, "testnet and mainnet never
    share a facilitator" (:81), the edge and database networks.
  - Image and deploy workflow (:205–300): mainnet is promoted by a digest that ran on testnet. With
    one service, every deploy reaches both networks, so that safety step moves to staging →
    production or is dropped knowingly. The environments, SSH keys per network and
    `deploy/testnet` follow.
  - Keys, secrets and access (:372–383), Store (:413, :444), Consequences and the 0026 build list
    (:511, :620–626).
- **`docs/architecture/m1-spine.md`:** :102 (a process serves one network; `/verify` dispatches by
  network instead of rejecting another), :160 (a database per network), :393 (the diagram). AD-12's
  one key per network stays.
- **ADR 0012:** keeps a database per network (decided 2026-10-28, below); it changes only where
  it says one container per facilitator.
- **ADR 0013:** the facilitator can no longer be kept from the other network's OpenBao socket,
  since one process holds both. Record the trade-off.
- **ADR 0004** (:37): reject a payment for another network becomes dispatch by network.
- **0026:** `facilitator-testnet`, `postgres-testnet`, `x402@testnet`, `/srv/x402/testnet/` and
  the rest of its 36 per-network lines.
- **0038:** its premise (one container per network) changes.
- **0027 (Oskar's note on #75):** one uptime check, the 99% figure, the zone's rate limits and its
  analytics cover both networks at once.
- **Code:** `NETWORK` becomes the set of networks served; the channel pool, signer, RPC endpoints
  and store are kept per network inside one process; `/supported` lists both.

## Open Questions

- Deploy safety without testnet-first promotion: staging and production environments, or one
  deploy for both networks?
- One process holding both networks' signing access: accepted for M1, or a reason to keep mainnet
  apart?
- Two Postgres containers, as ADR 0012 has today, or one container with both databases? One
  saves about 1 GiB of the limits and a backup setup; two keep a Postgres crash or upgrade from
  taking down both networks, which counts against mainnet's 99%.

## Decided

- **A database per network** (Stan, 2026-10-28). The process opens one store per network, beside
  that network's pool, key and RPC endpoints, so the schema stays as it is: none of the 8 tables
  in `apps/facilitator/src/adapters/postgres-schema.ts` records a network. A testnet reset wipes
  only testnet's database, and backups, restores and migrations stay per network.

## Acceptance Criteria

- [ ] ADR 0011, 0012, 0013, 0004 and the spine describe one facilitator service for both networks
- [ ] 0026, 0027 and 0038 match
- [ ] The facilitator serves `stellar:testnet` and `stellar:pubnet` from one process, each with its
      own channel pool, key and RPC endpoints, and `/supported` lists both
- [ ] Reviewed by Oskar and Marek
