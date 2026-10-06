---
id: "0011"
title: "Signer pool operations: resize the pool, detailed errors and an XDR fixture"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0007"]
tags: [signer-pool, operations, priority-low, effort-medium]
links:
  - ../active/0007_FEATURE_facilitator-settlement-submitter.md
history:
  - date: "2026-10-06"
    status: backlog
    who: claude
    note: "Spawned from 0007 future work; items Adam listed as not asked for in the PR #4 review."
---

# Signer pool operations: resize the pool, detailed errors and an XDR fixture

## Summary

Follow-ups to `packages/signer-pool` that 0007 left out. None of them blocks the facilitator.

## Implementation

- **Resize the pool at runtime (0007 step 1):**
  - add and remove channels on a running submitter;
  - merge a removed channel back into the facilitator to reclaim its 1.5 XLM;
  - derive a default pool size from a target rate.
- **Detailed errors:** an on-chain failure now reports only `txFailed`. Add the operation result
  and the host error from the result meta.
- **XDR fixture:** pin SDK 16.3's parsing of protocol 29 data (CAP-71 `AddressV2` credentials,
  fee bumps, `LedgerCloseMeta` v2) with recorded testnet XDR, so an SDK upgrade can't silently
  break it (0007 Emerged 1).

## Acceptance Criteria

- [ ] Channels can be added and removed at runtime, with reserve reclaim
- [ ] Failed results carry the operation and host error codes
- [ ] A fixture test parses recorded protocol 29 XDR
