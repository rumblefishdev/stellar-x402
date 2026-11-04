---
id: "0098"
title: "Fix the minors left from 0024's reviews"
type: BUG
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0024"]
tags: [facilitator, fees, priority-low, effort-small, platform]
links: []
history:
  - date: "2026-11-02"
    status: backlog
    who: akot
    note: "Spawned from 0024 future work."
---

# Fix the minors left from 0024's reviews

## Summary

0024's per-task and final reviews left these as minors: none breaks an acceptance criterion or a
payment. Take the ones still worth it.

## Implementation

- `onFinal`'s commit/release failure is neither counted nor retried, and faults are fed one by one
  (a failing write drops the rest).
- The last reserve attempt can run about 2 s past the deadline (lock timeout); a failed breaker
  read refuses at once while `reserve` retries.
- `recordSuccess` can wait on `reserve`'s scope lock up to `statement_timeout`; a backoff `factor`
  below 1 is treated as 1, undocumented.
- `errorEvent` decodes the contract and data outside their own guards: a bad address in the data
  drops the decoded error too.
- A payer-busy waiter's last re-claim near the budget's end can turn into `…_timeout`; waiters are
  not FIFO.
- Concurrent first `kind()` calls each hit the RPC.
- The spend-matrix script drops its schema only on success, and doesn't check the refusal reasons
  of its parallel case.
- The first failed floor read is not retried before the first tick.
- Test gaps: no `/settle`-level zero-amount or `payer_not_authorized` end-to-end test, no test of
  the 16 h → 24 h cap step.

## Acceptance Criteria

- [ ] Given each item above, when the task ends, then it is fixed or noted as not worth fixing
