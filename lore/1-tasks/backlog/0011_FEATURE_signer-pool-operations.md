---
id: "0011"
title: "Resize the signer pool at runtime"
type: FEATURE
status: backlog
milestone: 3
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
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Rescoped by okarcz in the M1 Payments cleanup: detailed errors done by 0024 (b825f537); the task keeps the runtime resize and moves to M3, around mainnet volume.
---

# Resize the signer pool at runtime

## Summary

Follow-ups to `packages/signer-pool` that 0007 left out. None of them blocks the facilitator.
Until it is built, a resize is a change to `CHANNELS` and a deploy. It matters at mainnet volume, or when
the one-call-per-channel startup read meets a public RPC that refuses some of them.

## Implementation

- **Resize the pool at runtime (0007 step 1):**
  - add and remove channels on a running submitter;
  - merge a removed channel back into the facilitator to reclaim its 1.5 XLM;
  - derive a default pool size from a target rate;
  - from 0020: read every channel at startup in one `getLedgerEntries` call (up to 200 keys)
    instead of one call per channel. 0007 measured 14–30 refusals in 200 simultaneous reads on the
    public testnet RPC, and since 0051 a refused read stops startup.
- **Detailed errors:** done by 0024 (`failureCause`, `b825f537`): an on-chain failure carries the
  operation result and the host error.
- **XDR fixture:** moved to 0016.

## Acceptance Criteria

- [ ] Channels can be added and removed at runtime, with reserve reclaim
- [x] Failed results carry the operation and host error codes (done by 0024: `failureCause`,
      `b825f537`)
