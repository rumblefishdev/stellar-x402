---
id: "0077"
title: "Run one facilitator service for both networks, the network chosen per request"
type: FEATURE
status: active
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
  - date: "2026-10-28"
    status: active
    who: stkrolikiewicz
    note: "Started: deploy safety without testnet-first promotion first, then the ADR 0011 rework."
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

## Plan

- **PR A:** ADR 0011, 0026 and 0038, what 0026's deploy is built from.
- **PR B:** the spine, ADR 0004, 0012 and 0013.
- **PR C:** the code. Not needed for M1: testnet runs on one network as today.

## Open Questions

- One process holding both networks' signing access: ADR 0011 states it (PR A); ADR 0013's
  reasons for a socket per facilitator are weighed in PR B.

## Decided

- **A database per network** (Stan, 2026-10-28). The process opens one store per network, beside
  that network's pool, key and RPC endpoints, so the schema stays as it is: none of the 8 tables
  in `apps/facilitator/src/adapters/postgres-schema.ts` records a network. A testnet reset wipes
  only testnet's database, and backups, restores and migrations stay per network.
- **One environment, `production`** (Stan, 2026-10-28), serving testnet now and mainnet later; a
  staging environment maybe later. Deploys go straight to production from `deploy/production`,
  with no promotion step; how deploys stay safe once mainnet joins is a question in 0038.

## Design Decisions

### Emerged

1. **The environment is in the names** (PR A): `/srv/x402/production/`, the Compose project
   `x402-production`, `x402@production`, `x402-deploy@production`, `x402-tunnel@production`. A
   staging environment would then need no rename of a running production: its units, paths,
   volumes and backups.
2. **A Postgres container per network** (PR A): `postgres-<network>` under
   `x402-db@<environment>-<network>` (today `x402-db@production-testnet`), as ADR 0012 has it.
   One container with both databases would save about 1 GiB and a backup setup, but a Postgres
   crash or upgrade would take both networks down.
3. **One internal database network per environment,** `x402-production-db`, instead of one per
   network: the one facilitator reaches both databases anyway, and each migration service gets
   only its own network's password.
4. **OpenBao is its own Compose project,** `x402-openbao`, and the facilitator mounts its
   per-network sockets as external volumes.
5. **0026's deploy waits for `listed` too,** as ADR 0011 has since 0019 (`05dcfae`); 0026 still
   said `ready` only.
6. **0038 takes the mainnet questions 0077 opens** (deploy safety, the memory limit, one uptime
   check for both networks) and drops the mainnet tunnel and the digest check in a mainnet
   `deploy.sh`.

## Acceptance Criteria

- [ ] ADR 0011, 0012, 0013, 0004 and the spine describe one facilitator service for both networks
- [x] 0026, 0027 and 0038 match (PR A; 0027 needed no change)
- [ ] The facilitator serves `stellar:testnet` and `stellar:pubnet` from one process, each with its
      own channel pool, key and RPC endpoints, and `/supported` lists both
- [ ] Reviewed by Oskar and Marek
