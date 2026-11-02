---
id: "0088"
title: "Don't take NOT_FOUND at the bound ledger itself as expired"
type: BUG
status: active
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
  - date: "2026-11-02"
    status: active
    who: akot
    note: "Started."
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

- [x] Given a transaction that landed in its bound ledger E, when `getTransaction` answers
      `NOT_FOUND` with `latestLedger = E`, then the record isn't ended `expired` on that answer
- [x] Given a node whose history starts after the envelope was built, when it answers `NOT_FOUND`
      past the bound in `confirm()`, then the record isn't ended `expired` and the channel is free
      again
- [x] Given a record that ended `expired`, when one of its hashes is then found landed, then a log
      line and a metric report it

## Implementation Notes

- `cannotLand` in `packages/signer-pool/src/submitter.ts`, the one rule for `confirm()` and
  `pastBound` in `reconcile.ts`: on `NOT_FOUND`, `latestLedger > maxLedger`, also for a bound read
  from the auth entry. The comment at `fallback-rpc.ts:73` said an endpoint can't report too early;
  true of lag, not of the race.
- `confirm()` answers `pending` when `oldestLedger` is past the ledger the envelope was built on,
  and drops the channel's sequence. `records.ts` logs `settlement_landed_after_expired`.
- Tests: `settlement-guards.test.ts` and `reconcile.test.ts` take a first `NOT_FOUND` at E, then
  `SUCCESS`. Both failed before the change. The fallback bound stays open at `AUTH_EXPIRY`.
- Research, with sources: [R-not-found-at-bound](notes/R-not-found-at-bound.md).

**Modified tests:** the fixtures past the bound in `reconcile.test.ts` and one in `settle.test.ts`
read `latestLedger` at the bound, so they move one ledger on. "reports expired once the ledger bound
passes" now checks the last read's ledger: `fake.ledger` also moves with the clock's polls.

## Design Decisions

### From Plan

1. **One more ledger, not a second read**: one response decides, whichever node answered. A second
   read proves it only if both calls reach one node, which a URL doesn't show.

### Emerged

2. **Only on `NOT_FOUND`**: the guards before a send keep `>=` (`pastLedgerBound`), which is right
   for whether a new envelope can still land.
3. **`maxTime` stays as it is**: a close time past it is already a ledger the transaction can't
   have landed in.
4. **The race narrows, and doesn't close**: one request that stalls from E's commit to E+1's publish
   still answers wrongly. That takes about 5 s live, less on a node catching up. No data says it
   needs closing.
5. **`expired` comes one ledger later**: a follower whose deadline falls in that ledger gets
   `QueueTimeoutError`, and a `/settle` whose budget ends there gets `pending`. Nothing is paid
   either way.
6. **A node without the history gets `pending`, not a longer wait** (code review): waiting would
   hold the channel for as long as the node lacks the ledgers. `pending` frees it, and
   reconciliation finishes the record or reports `settlement_history_gone`. The check compares
   ledgers, not `historyCovers`' close times, since the pool has the envelope's ledger.
7. **A landing after `expired` is reported, not corrected**: `expired` is final and the payer may
   already have signed again, so the record stays and an operator decides.
