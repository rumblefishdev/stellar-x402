---
id: "0011"
title: "Signer pool operations: resize the pool and detailed errors"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0007", "0016"]
tags: [signer-pool, operations, priority-low, effort-medium, payments]
links:
  - ../archive/0007_FEATURE_facilitator-settlement-submitter.md
history:
  - date: "2026-10-06"
    status: backlog
    who: claude
    note: "Spawned from 0007 future work; items Adam listed as not asked for in the PR #4 review."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "XDR fixture moved to 0016 (T1 prerequisite)."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Tagged Payments lane by 0012 (outside T1)."
---

# Signer pool operations: resize the pool and detailed errors

## Summary

Follow-ups to `packages/signer-pool` that 0007 left out. None of them blocks the facilitator.

## Implementation

- **Resize the pool at runtime (0007 step 1):**
  - add and remove channels on a running submitter;
  - merge a removed channel back into the facilitator to reclaim its 1.5 XLM;
  - derive a default pool size from a target rate.
- **Detailed errors:** an on-chain failure now reports only `txFailed`. Add the operation result
  and the host error from the result meta.
- **XDR fixture:** moved to 0016.

## Acceptance Criteria

- [ ] Channels can be added and removed at runtime, with reserve reclaim
- [ ] Failed results carry the operation and host error codes
