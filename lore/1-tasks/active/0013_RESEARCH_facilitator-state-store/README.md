---
id: "0013"
title: "Choose the facilitator's state store and record it in an ADR"
type: RESEARCH
status: active
milestone: 1
related_adr: ["0003", "0006", "0007", "0008", "0011", "0012"]
related_tasks: ["0012", "0009", "0014", "0022"]
tags: [facilitator, persistence, bazaar, priority-high, effort-small, discovery]
links:
  - ../../../../docs/adr/0003-settlement-channel-account-pool.md
  - ../../../../docs/x402-settlement-scaling-en.md
  - ../../../../docs/planning/m1-epics.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Spawned from the 0012 M1 architecture session: the store choice needs its own research."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Added the store operations required by the final M1 spine (AD-6, AD-16 to AD-20) and the spend budgets."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Tagged Discovery lane by 0012; decision task feeding M1 Epic 2."
  - date: "2026-10-12"
    status: active
    who: akot
    note: "Started by the Discovery lane; picks the one database the team agreed on, for the 0014 host."
  - date: "2026-10-12"
    status: active
    who: akot
    note: "Six options compared, server PostgreSQL and embedded SQLite spiked against the 0031 contract suites (23/23); RDS for PostgreSQL chosen, ADR 0012."
---

# Choose the facilitator's state store and record it in an ADR

## Summary

Research where the facilitator keeps its state, pick one option, and record the choice in an ADR.
The M1 architecture spine (0012) needs this answer before the facilitator app is built.

## Context

The 0012 architecture session settled the facilitator's shape:
- `/verify` uses `@x402/stellar`'s rules.
- `/settle` goes through `signer-pool` for every `exact` payment (ADR 0003).

So T1 needs state in four places:

1. **Settlement record:**
   - Stores the hash from `onSigned` before the first send.
   - Dedupes on `(payer, nonce)`.
   - Keeps the final outcome so a retried `/settle` after `settlement_pending` gets the same
     answer (ADR-R1, 0009).
   - A restart must not lose a payment that may still land.
2. **Bazaar catalog:**
   - Cataloging writes resources after a successful settle.
   - The `resources` endpoint reads them.
   - Search and ranking come in T2 and will query the same data.
3. **Rate-limit counters:** T1 runs a single testnet instance, and mainnet may run more than one.
4. **Spend budgets** (AD-18): global, per-payer, per-`payTo` and per-asset fee budgets, reserved
   before each submit.

Operations the store must support (from the final M1 spine; AD numbers refer to it):
- **AD-6:** atomic insert-if-absent claim on `network:payer:nonce`.
- **AD-16:** forward-only compare-and-set state changes, and lookup by any of a settlement's
  hashes.
- **AD-17:** an exclusive, renewable lease on a network's channel set.
- **AD-19:** the catalog key `network + payTo + method + normalized URL`, with idempotent upserts.
- **AD-20:** the `/discovery/resources` filters (`type`, `payTo`, `network`, `extensions`,
  `limit`, `offset`).
- The hash is written from an awaited `onSigned` (0016), so a write's latency adds to each
  settlement.

Options raised in the session:
- **Postgres:** one store, durable, ready for more than one instance, and its full-text search
  could serve T2 ranking.
- **SQLite on a persistent volume:** no database service to run; we'd migrate later.
- **In-memory:** ruled out for the settlement record, which must survive restarts.

The store is closely tied to hosting, so the research should note what each option needs from
the host.

From 0014 ([ADR 0011](../../../../docs/adr/0011-facilitator-hosting.md)): the host is ECS on
Fargate in AWS. RDS PostgreSQL fits: db.t4g.micro single-AZ on testnet (~$17/mo with storage),
db.t4g.small Multi-AZ on mainnet (~$68/mo). SQLite
doesn't: Fargate's only persistent volume is EFS, an NFS mount that SQLite advises against, so
SQLite would move the facilitator to EC2 with EBS.

## Implementation Plan

### Step 1: Requirements

- Write down, for each of the four kinds of state:
  - consistency needs (dedupe must be atomic)
  - durability
  - expected volume (from the ADR 0003 throughput numbers)
  - read patterns
  - retention
- Separate what T1 (testnet, one instance) needs from what mainnet will need.

### Step 2: Compare options

- At least: Postgres (managed), SQLite on a volume, and Redis or another KV store for rate
  limits.
- Criteria:
  - atomic `(payer, nonce)` dedupe
  - durability across restarts
  - more than one instance
  - fit for T2 search
  - operating cost on testnet and mainnet
  - hosting requirements
  - TS driver and migration tooling, versions checked on the web
  - test story (in-memory fakes behind interfaces)
- Record the findings as R- and S- notes in `notes/`.

### Step 3: Decide and record

- Pick the store, or one store per kind of state if that is clearly better.
- Write the ADR in `docs/adr/` with the next free number. It must include:
  - context
  - options considered
  - the decision, with the reasons it beats the alternatives
  - consequences, including the migration path to mainnet
- Note which store interfaces the facilitator owns, so the 0012 spine can bind them.

## Acceptance Criteria

- [x] Requirements for the four kinds of state written down (T1 versus mainnet)
      ([R-state-store-options](notes/R-state-store-options.md))
- [x] At least three options compared against the criteria above, with sources (six options)
- [x] Store chosen: one RDS for PostgreSQL database ([S-state-store-decision](notes/S-state-store-decision.md))
- [x] ADR in `docs/adr/` documenting the decision and explaining why it was made over the
      alternatives, linked from this task's `related_adr` ([ADR 0012](../../../../docs/adr/0012-facilitator-state-store.md))
- [x] The 0012 architecture spine updated to reference the ADR (AD-7, ADR table, Deferred)

## Result

- One RDS for PostgreSQL instance per network holds all four ports and the Tranche 2 search:
  db.t4g.micro Single-AZ on testnet, Multi-AZ on mainnet.
- The four ports in `apps/facilitator/src/ports/` stay the store interfaces the facilitator owns.
- A local spike ran the contract suites as of task 0031 (23 cases), unchanged, on PostgreSQL 18.6
  and SQLite. Both passed 23/23; on SQLite the concurrent cases pass by construction (one
  connection). This branch depends on 0014 (PR #16, ADR 0011) merging first.
  [G-postgres-port-mapping](notes/G-postgres-port-mapping.md) holds the schema and statements
  for 0022.

## Design Decisions

### From Plan

1. **One store for every kind of state.** The team agreed on a single database, so the split
   options weren't pursued. That covers Redis or Valkey for rate limits, and DynamoDB for the hot
   path with PostgreSQL for the catalog. Both are recorded as rejected alternatives in the ADR.

### Emerged

2. **Weights fixed before the research,** listed in
   [S-state-store-decision](notes/S-state-store-decision.md#scoring).
3. **Two architectures were spiked locally** (server PostgreSQL and embedded SQLite) before the
   decision. Aurora shares the PostgreSQL adapter. Contract results outrank documentation where
   they disagree.
4. **Read Committed only.** At Repeatable Read the spend reserve's scope locks don't stop overspend
   (PostgreSQL docs, reproduced on 18.6). In the spike, the contract failed when those locks were
   removed.
5. **Rate-limit window uses `GREATEST`** (found in review): a hit from an older window must not
   reset the count once more than one ECS task writes it. The spike and memory adapter use `=`;
   0022 adds the contract case.

## Open Questions (for the team)

- **T2 search: keyword, semantic or both?** PostgreSQL covers all three. The answer only matters if
  the one-database rule is ever revisited.
- **Should `ChannelLease` carry a fencing token, so a stale holder's writes are rejected?** This is a
  contract change in 0025.
- **What should `addHash` do with a hash another settlement already has?** Reject: keying hashes by
  hash already enforces it. The memory adapter appends today (0022).
- **Which class for mainnet?** Burstable t4g.small, a non-burstable class, or a Multi-AZ DB cluster,
  priced before launch (ADR 0012).
