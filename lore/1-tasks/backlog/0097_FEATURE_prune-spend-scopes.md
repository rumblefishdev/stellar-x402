---
id: "0097"
title: "Prune spend_scopes rows nothing counts any more"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007", "0012"]
related_tasks: ["0024", "0050"]
tags: [facilitator, persistence, priority-low, effort-small, platform]
links: []
history:
  - date: "2026-11-02"
    status: backlog
    who: akot
    note: "Spawned from 0024 future work."
---

# Prune spend_scopes rows nothing counts any more

> Taken in by 0024 (decisions 39 and 42, PR #105): `pruneScopes` in 0050's pruner. Close this
> task when #105 merges.

## Summary

0024 keeps a `spend_scopes` row per payer, `payTo`, asset and breaker scope, and the pruner (0050)
covers `spend_reservations` only. Payer addresses are free, so the table grows for good.

## Implementation

- Delete a scope row whose window, breaker and strikes have all aged out and that no reservation
  still counts against, in the pruner's bounded batches.
- Skip a row another call is writing, as the reservations' prune does.

## Acceptance Criteria

- [ ] Given a scope with nothing in any window and no breaker or strike still fresh, when the
      pruner runs, then its row is deleted
- [ ] Given a scope with a live reservation, an open breaker or a fresh strike, when the pruner
      runs, then its row stays, and `reserve` is unaffected
