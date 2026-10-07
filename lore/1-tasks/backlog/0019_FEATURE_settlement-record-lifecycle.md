---
id: "0019"
title: "Settlement records survive restarts"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0006"]
related_tasks: ["0012", "0009", "0016"]
tags: [facilitator, settlement, priority-high, effort-medium, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.5 (Payments lane)."
---

# Settlement records survive restarts

## Summary

As a facilitator operator, I want settlement records that are written before sending, only move forward, and are reconciled at startup, so that a crash or restart never loses a payment that may still land and never charges a buyer twice.

**Story:** [M1 Story 1.5](../../../docs/planning/m1-epics.md#story-15-settlement-records-survive-restarts) · **Lane:** Payments · **Covers:** FR10 (AD-16)

## Context

- 0009 claims and submits; this story makes the record durable and correct across restarts and late events.
- Needs the awaited `onSigned` from 0016.
- Related tasks: 0009, 0016.

## Implementation

- Settlement module in `settlement/` owning all `SettlementStore` writes, with forward-only compare-and-set.
- Multi-hash records and lookup by any hash.
- Startup reconciliation that runs before the HTTP server accepts traffic.
- Tests with the in-memory store and `fake-rpc`, including a simulated crash between sign and send.

## Acceptance Criteria

- [ ] Given a claimed settlement, when the pool signs its transaction, then the hash is written to `SettlementStore` through the awaited `onSigned` before the first send; if the write fails, nothing is sent
- [ ] Given a rebuild that produces a new hash, when it is signed, then the record keeps every hash and can be found by any of them
- [ ] Given a write that would move a record backwards, such as `pending` after `success`, when it arrives late, then the compare-and-set drops it; states only move `claimed → signed → pending → success | failed | rejected | expired`
- [ ] Given non-final records in the store, when the app starts, then before accepting traffic it checks each one on chain by its hashes and finalizes it; a record that turns `success` this way fires the on-success hook
- [ ] Given any handler or event listener, when it needs to change a record, then it calls the single settlement module, which owns every write to `SettlementStore`
