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
  `pastBound` in `reconcile.ts`: on `NOT_FOUND`, `latestLedger >= maxLedger + 3`
  (`NOT_FOUND_MARGIN_LEDGERS`), also for a bound read from the auth entry, and a close time past
  `maxTime + 15` (`NOT_FOUND_MARGIN_SECONDS`). The comment at `fallback-rpc.ts:73` said an endpoint
  can't report too early; true of lag, not of the race.
- `confirm()` answers `pending` when `oldestLedger` is past the ledger the envelope was built on,
  and drops the channel's sequence. A late `pending` emits no `resolved`: nothing ended.
  `types.ts` says so: `pending` minus `resolved` no longer counts what is still being confirmed.
  `records.ts` logs `settlement_landed_after_expired` with the hash, the ledger and the state.
- Tests: `settlement-guards.test.ts` and `reconcile.test.ts` take `NOT_FOUND` from E to E+2, then
  `SUCCESS`, and the pool also up to 15 s of close time past `maxTime`. All failed before the
  change. The fallback bound stays open to `AUTH_EXPIRY + 2`.
- Research, with sources: [R-not-found-at-bound](notes/R-not-found-at-bound.md).

**Modified tests:** the fixtures past the bound in `reconcile.test.ts`, one in `settle.test.ts` and
the ledger loop in `drain-takeover.test.ts` read `latestLedger` just past the bound, so they move to
three ledgers past it. "reports expired
once the ledger bound passes" now checks the last read's ledger: `fake.ledger` also moves with the
clock's polls.

## Design Decisions

### From Plan

1. **A margin, not a second read**: one response decides, whichever node answered. A second read
   proves it only if both calls reach one node, which a URL doesn't show.

### Emerged

2. **Only on `NOT_FOUND`**: the guards before a send keep `>=` (`pastLedgerBound`), which is right
   for whether a new envelope can still land.
3. **`maxTime` gets the margin too** (PR review): core's rule needs none, but the read does. An
   answer can miss the last ledger that closed by `maxTime`, as it can miss `maxLedger`. So
   `NOT_FOUND` decides only at a close time `NOT_FOUND_MARGIN_SECONDS` (15 s) past `maxTime`. The
   facilitator always passes `maxLedger` (`settle.ts:628`), so this covers the pool's default path
   and hashes stored before 0073.
4. **Three ledgers, not one** (PR review): the race needs one answer to span the margin. One ledger
   is about 5 s, a stall a live node can produce. Three are about 15 s, and `FallbackRpc` drops any
   answer after 10 s. `NOT_FOUND_MARGIN_LEDGERS` must stay above that timeout, and a test ties it to
   `UPSTREAM_TIMEOUT_MS`. A node catching up closes ledgers faster, so there the race stays.
5. **`expired` comes three ledgers later**: about 15 s, only for a payment that didn't land. A
   follower whose deadline falls in them gets `QueueTimeoutError`, and a `/settle` whose budget ends
   there gets `pending`. Nothing is paid either way.
6. **A node without the history gets `pending`, not a longer wait** (code review): waiting would
   hold the channel for as long as the node lacks the ledgers. `pending` frees it, and
   reconciliation finishes the record or reports `settlement_history_gone`. The check compares
   ledgers, not `historyCovers`' close times, since the pool has the envelope's ledger.
7. **A landing after `expired` is reported, not corrected**: `expired` is final and the payer may
   already have signed again, so the record stays and an operator decides. The report fires only
   while a confirmation is still running, since nothing reads an `expired` hash again: a wrong
   `expired` from `confirm()`, or from a sweep with no confirmation running, isn't reported, and a
   zero doesn't prove there were none.
