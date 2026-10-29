---
id: "0088"
title: "Don't take NOT_FOUND at the bound ledger itself as expired"
type: BUG
status: backlog
milestone: 1
related_adr: ["0006"]
related_tasks: ["0073", "0019"]
tags: [facilitator, signer-pool, settlement, priority-low, effort-small]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: "Spawned from 0073's PR #85 review (Adam): a narrow window, on develop already."
---

# Don't take NOT_FOUND at the bound ledger itself as expired

## Summary

stellar-rpc's `getTransaction` reads the transaction and then the ledger range with no snapshot
between them (`get_transaction.go:50-53`), so it can answer `NOT_FOUND` with `latestLedger = E`
for a transaction that landed in ledger E. Read at the bound, that answer ends the record
`expired` for a payment that landed.

## Implementation

- Answer `expired` from a `NOT_FOUND` only once `latestLedger` is past the bound by one more
  ledger (or after a second read), in `confirm()` and in reconciliation.
- A test where the first `NOT_FOUND` at E is followed by `SUCCESS`.

## Acceptance Criteria

- [ ] Given a transaction that landed in its bound ledger E, when `getTransaction` answers
      `NOT_FOUND` with `latestLedger = E`, then the record isn't ended `expired` on that answer
