---
id: "0087"
title: "Confirm a settlement by its inner hash, so a rewrapped fee bump isn't recorded expired"
type: BUG
status: backlog
milestone: 1
related_adr: ["0006"]
related_tasks: ["0073", "0019"]
tags: [facilitator, signer-pool, settlement, priority-high, effort-medium]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR #85 review (Adam): on develop already, raised as high priority.
---

# Confirm a settlement by its inner hash, so a rewrapped fee bump isn't recorded expired

## Summary

Only the fee source signs a fee bump, and stellar-core's replace-by-fee takes any fee source at
10× the fee. A third party can rewrap our inner transaction in its own fee bump, and it lands
under another outer hash. `confirm()` and reconciliation look only at our outer hash, so the
record ends `…_transaction_expired` ("sign a new payment") for a payment that landed.

## Context

- `packages/signer-pool/src/submitter.ts` `confirm()` (about `:702`, `:876-910`) and
  `apps/facilitator/src/settlement/reconcile.ts` (about `:203`) ask `getTransaction` for the
  outer hash only. stellar-rpc indexes the inner hash too.
- 0073 makes `expired` mean "can't land"; spine AD-22 and ADR 0006 now say that holds for our own
  outer hash and point here.
- Checked from source, not run on the network.

## Implementation

- Store the inner hash next to each outer hash (an attempt field or a migration).
- Confirm and reconcile by the inner hash, or by both, before answering `expired`.
- A test with a rewrapped fee bump that lands: the record ends `success` with the hash that
  landed.

## Acceptance Criteria

- [ ] Given our inner transaction landed under another fee bump, when the pool or reconciliation
      confirms it, then the record ends `success`, not `…_transaction_expired`
