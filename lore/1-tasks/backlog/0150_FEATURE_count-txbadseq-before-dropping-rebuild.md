---
id: "0150"
title: "Count txBadSeq in production, then decide whether the rebuild stays"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0003", "0011"]
related_tasks: ["0090"]
tags: [facilitator, signer-pool, payments, priority-low, effort-small]
links:
  - ../archive/0090_FEATURE_skip-channels-with-open-hash.md
history:
  - date: "2026-11-17"
    status: backlog
    who: okarcz
    note: "Spawned from 0090 future work (Karol's question of 2026-11-05)."
---

# Count txBadSeq in production, then decide whether the rebuild stays

## Summary

When a send fails with `txBadSeq`, the pool rebuilds the transaction with a new sequence and a new
hash. That rebuild is the only source of a second hash on one settlement record. ADR 0003's load
runs counted 0 sequence errors with one process, and 0090 removed the known deploy-overlap case, so
the rebuild may have no case left. Measure before deciding.

## Context

- 0090 holds back a channel the previous process left a transaction open on; before it, the next
  process's sends on that channel could fail with `txBadSeq` and rebuild.
- The first deploy that ships 0090 can still see such rebuilds, as hashes stored before 0090 carry
  no channel (0090, code review D2). Count after that deploy.
- Nothing counts `txBadSeq` today.

## Implementation

- Count `txBadSeq` (and the rebuilds it causes) in a metric or a log line the alarms can read.
- Watch production through several deploys and normal traffic.
- If no case is left, propose removing the rebuild and, with it, several hashes per record;
  otherwise write down which case keeps it.

## Acceptance Criteria

- [ ] `txBadSeq` sends are counted in production
- [ ] After several deploys, a written answer: the rebuild stays (with the case it covers) or a
      task to remove it
