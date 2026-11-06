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
  - date: "2026-10-28"
    status: active
    who: stkrolikiewicz
    note: "Oskar's review of #79: Wants= instead of Requires= on the database units, x402-db-<network>@<environment>, secret files named per network, the database network's cost, ready per network left to PR C, one process's costs in 0038, and status notes in ADR 0012 and 0013."
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

For PR C (ADR 0012 lists them):

- **Which database holds the catalog.** `/discovery/resources` without a `network` filter lists
  both networks, with an exact `total` and an `offset` up to 1 000 000, but each network's entries
  are in its own database. Merging two queries costs `offset + limit` rows from each; one database
  for the catalog keeps a testnet reset from wiping testnet's listings.
- **Which database holds the IP rate limiter's counters.** They are counted before the request's
  network is known, and `/supported` and `/discovery/*` may carry none.

## Decided

- **A database per network** (Stan, 2026-10-28). The process opens one store per network, beside
  that network's pool, key and RPC endpoints, so the schema stays as it is: in
  `apps/facilitator/src/adapters/postgres-schema.ts` the settlement and catalog tables record the
  network, but the lease, rate-limit and spend tables don't (corrected in PR B). A testnet reset
  wipes only testnet's database, and backups, restores and migrations stay per network.
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
   `x402-db-<network>@<environment>` (today `x402-db-testnet@production`), as ADR 0012 has it.
   One container with both databases would save about 1 GiB and a backup setup, but a Postgres
   crash or upgrade would take both networks down. The facilitator's unit only wants the
   database units (`Wants=`, not `Requires=`), or one database's restart would restart the
   facilitator for both networks (Oskar's review of #79).
3. **One internal database network per environment,** `x402-production-db`, instead of one per
   network: the one facilitator reaches both databases anyway, and each migration service gets
   only its own network's password. The cost: once mainnet joins, every migration service
   reaches every Postgres, and only the password keeps `migrate-mainnet` out of testnet's
   database.
4. **OpenBao is its own Compose project,** `x402-openbao`, and the facilitator mounts its
   per-network sockets as external volumes.
5. **0026's deploy waits for `listed` too,** as ADR 0011 has since 0019 (`05dcfae`); 0026 still
   said `ready` only.
6. **0038 takes the mainnet questions 0077 opens** (deploy safety, the memory limit, one uptime
   check for both networks, what one process costs a network's restarts and key rotations) and
   drops the mainnet tunnel and the digest check in a mainnet `deploy.sh`.
7. **The network is in the database unit's template name,** `x402-db-testnet@production`, not
   its instance (`x402-db@production-testnet`), so `%i` is the environment as in every other unit
   and no unit parses it; a template per network (Oskar's review of #79).
8. **Secret files are named per network now** (`database-url.testnet`, `rpc-urls.testnet`,
   `postgres-password.testnet`, the AppRole files), so mainnet's files sit beside testnet's in
   `/run/x402/production/` and nothing is renamed (Oskar's review of #79).
9. **`ready` is today's one network's lease;** what readiness means with a lease per network is
   decided with the code in PR C (Oskar's review of #79).
10. **A lease per network** (PR B, spine AD-17): the process takes each served network's channel
    lease through that network's store, and without a network's lease it doesn't serve `/settle`
    for that network. What `ready` reports stays with PR C (decision 9).
11. **Spend budgets per network** (PR B, spine AD-18, ADR 0012): each network's budgets live in
    its own store and count only the fees its own fee account pays, so the global budget is per
    network.
12. **The per-network keys, policies, AppRoles and sockets stay** (PR B, ADR 0013). One process
    holds both, so a break-in on it signs for both networks; testnet's code paths now run beside
    mainnet's key. The separate ones still keep a leaked token or secret ID, a rotation and the
    audit log to one network, and keep a later split into a process per network free. One socket
    and AppRole for both was rejected.
13. **`/supported` per network served** (PR B, spine AD-13): an `exact` kind per network, and
    under `stellar:*` each network's facilitator key, since upstream keys `signers` by CAIP
    family.

## Acceptance Criteria

- [x] ADR 0011, 0012, 0013, 0004 and the spine describe one facilitator service for both networks
      (PR A: ADR 0011; PR B: the rest)
- [x] 0026, 0027 and 0038 match (PR A; 0027 needed no change)
- [ ] The facilitator serves `stellar:testnet` and `stellar:pubnet` from one process, each with its
      own channel pool, key and RPC endpoints, and `/supported` lists both
- [ ] Reviewed by Oskar and Marek
