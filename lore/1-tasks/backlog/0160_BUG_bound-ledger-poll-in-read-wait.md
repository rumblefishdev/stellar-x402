---
id: "0160"
title: "Bound the ledger poll in the wait between sequence reads"
type: BUG
status: backlog
related_adr: []
related_tasks: ["0056"]
tags: [signer-pool, payments, priority-low, effort-small]
links: []
history:
  - date: "2026-11-24"
    status: backlog
    who: okarcz
    note: "Spawned from 0056 future work (stkrolikiewicz's review of PR #218)."
---

# Bound the ledger poll in the wait between sequence reads

## Summary

Since 0056, a failing sequence read gives up right after a wait that ends on the caller's
deadline. The wait itself, `LedgerClock.following(stopAt)` (`packages/signer-pool/src/ledger-clock.ts`),
starts with a `getLatestLedger` poll that has no time limit; through FallbackRpc it can take
N URLs × 10 s. So during a slow-RPC outage the read can still end one poll past the deadline and
hold the channel that long.

## Context

Found in stkrolikiewicz's review of PR #218 (0056, decision 2). The facilitator's `budgetOver`
guard keeps anything from being signed late, so this only holds a channel longer than useful.

## Implementation

- Let the clock's poll end at the waiter's deadline (race it, or pass the deadline down), without
  breaking other waiters sharing the same poll.

## Acceptance Criteria

- [ ] Given ledger polls that hang longer than the time left, when a failing read waits for its
      deadline, then the read gives up at the deadline, not after the poll
