---
id: "0013"
title: "Choose the facilitator's state store and record it in an ADR"
type: RESEARCH
status: backlog
milestone: 1
related_adr: ["0003", "0006", "0007", "0008"]
related_tasks: ["0012", "0009"]
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
---

# Choose the facilitator's state store and record it in an ADR

## Summary

Research where the facilitator keeps its state, pick one option, and record the choice in an ADR.
The M1 architecture spine (0012) needs this answer before the facilitator app is built.

## Context

The 0012 architecture session settled the facilitator's shape:
- `/verify` uses `@x402/stellar`'s rules.
- `/settle` goes through `signer-pool` for every `exact` payment (ADR 0003).

So T1 needs state in three places:

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

The store is closely tied to hosting, which is still open, so the research should note what each
option needs from the host.

## Implementation Plan

### Step 1: Requirements

- Write down, for each of the three kinds of state:
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

- [ ] Requirements for the three kinds of state written down (T1 versus mainnet)
- [ ] At least three options compared against the criteria above, with sources
- [ ] Store chosen
- [ ] ADR in `docs/adr/` documenting the decision and explaining why it was made over the
      alternatives, linked from this task's `related_adr`
- [ ] The 0012 architecture spine updated to reference the ADR
