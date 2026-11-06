---
id: "0087"
title: "Confirm a settlement by its inner hash, so a rewrapped fee bump isn't recorded expired"
type: BUG
status: completed
milestone: 1
related_adr: ["0006"]
related_tasks: ["0073", "0019"]
tags: [facilitator, signer-pool, settlement, priority-high, effort-medium]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR #85 review (Adam): on develop already, raised as high priority.
  - date: "2026-11-04"
    status: active
    who: okarcz
    note: "Picked up by okarcz."
  - date: "2026-11-06"
    status: completed
    who: okarcz
    note: >
      Closed. #128 merged (rebase, bf52c1b4). The criterion is met by unit tests with a real
      fee-bump envelope; no rewrap was run on the network, since a smoke run can't make a rival
      fee bump replace ours. Adam's review added the history check on the inner read (decision
      9). 24 new tests in all (pool 9, store contract 4, reconcile 8, settle 3); facilitator 969,
      pool 188. 9 decisions, no follow-up tasks.
---

# Confirm a settlement by its inner hash, so a rewrapped fee bump isn't recorded expired

## Summary

Only the fee source signs a fee bump, and stellar-core's replace-by-fee takes any fee source at
10× the fee. A third party can rewrap our inner transaction in its own fee bump, and it lands
under another outer hash. `confirm()` and reconciliation look only at our outer hash, so the
record ends `…_transaction_expired` ("sign a new payment") for a payment that landed.

## Context

- `packages/signer-pool/src/submitter.ts` `confirm()` (about `:702`, `:876-910`) and
  `apps/facilitator/src/settlement/reconcile.ts` (about `:203`) ask `getTransaction` for the
  outer hash only. stellar-rpc indexes the inner hash too.
- 0073 makes `expired` mean "can't land"; spine AD-22 and ADR 0006 now say that holds for our own
  outer hash and point here.
- Checked from source, not run on the network.
- 2026-11-04: checked on testnet. `getTransaction` with a landed fee bump's inner hash (ledger
  5557070) answers `SUCCESS` with the whole fee-bump envelope, as the outer hash does.
- A send error can't end `rejected` for a payment someone else landed: a resend follows only
  `TRY_AGAIN_LATER` (never taken, so nobody saw the envelope) or a send that threw, which sets
  `uncertain` and goes on to confirm by hash. Only `confirm()` and reconciliation need the check.

## Implementation

- Store the inner hash next to each outer hash (an attempt field or a migration).
- Confirm and reconcile by the inner hash, or by both, before answering `expired`.
- A test with a rewrapped fee bump that lands: the record ends `success` with the hash that
  landed.

## Acceptance Criteria

- [x] Given our inner transaction landed under another fee bump, when the pool or reconciliation
      confirms it, then the record ends `success`, not `…_transaction_expired` (2026-11-04, unit
      tests with a real fee-bump envelope: pool, sweep, the pool's late result and `/settle`; no
      rewrap was run on the network)

## Implementation Notes

- `packages/signer-pool/src/submitter.ts`: `Prepared` carries the inner hash, and `onSigned`
  gets it as a third argument. In `confirm()`, at the `expired` return (bound passed, history
  covers), one `getTransaction(innerHash)`. Found: `rewrappedOutcome()` reads the envelope that
  landed, so the result has its hash, `feeCharged` 0 under someone else's fee bump, and
  `rewrap: { of, feeSource }`. Not found: `expired` as before. A failed read waits for the next
  ledger. `landedOutcome()` holds the old success/failed code, unchanged.
- `types.ts`: `SubmitResult.rewrap` and the `Rewrap` type.
- Migration `0012_settlement_inner_hash`: a nullable `inner_hash` on `settlement_hashes`.
  `addHash` takes it as an optional last argument and `attempts()` returns it.
- `MARK_ATTEMPTS`: an update with `rewrapOf` inserts its hash after the record's others, with our
  row's inner hash, so `hashes.at(-1)` (the answer's `transaction`) is the hash that landed and
  `findByHash` finds the record by it.
- `records.ts`: `attemptUpdates` writes ours `dead` and theirs `landed` for a rewrap, and
  `rewrapped()` logs `settlement_rewrapped` (warn: key, landed hash, ours, `feeSource`, state)
  and counts `settlement_rewrapped_total`.
- `settle.ts` passes the inner hash to `addHash` and logs a rewrap. `reconcile.ts`: the sweep
  reads the inner hash of an attempt past its bound before it is `dead`, and `resolved` finds the
  record by `rewrap.of`.
- Tests: pool 5 (inner hash given to `onSigned`, rewrap success, inner not found, failed read,
  bare inner transaction), store contract 4, reconcile 5, settle 1. Turned off, the pool and sweep
  fallbacks and the `rewrap.of` lookup each fail their tests. Full suite green: facilitator 869,
  pool 185.
- After the review: the inner read's `NOT_FOUND` counts only past the bound by its own answer, in
  the pool (`cannotLand`) and the sweep (`pastBound` and `historyCovers`). `/settle` logs a rewrap
  only when its write won. `settlement_history_gone` carries `innerHash`. The README documents
  `settlement_rewrapped`, and ADR 0006 the bare case's fee. 8 more tests: pool 3 (our own fee
  bump found by the inner hash, a node behind the bound, a failed rewrap), reconcile 3, settle 2;
  each fix, turned off, fails its test. Facilitator 874, pool 188.
- ADR 0006 (date line, attempts bullet) and spine AD-22 say the rewrap case is covered.
- After Adam's review of #128 (`b031fc66`): in `confirm()`, the inner read's `NOT_FOUND` from a
  node whose history starts after the envelope was built (`oldestLedger > simLedger`) answers
  `pending` and frees the cached sequence, before the `cannotLand` check. One more pool test;
  without the fix it ends `expired`.

## Issues Encountered

- **Existing test changed:** `settlement-guards.test.ts` "reports expired once the ledger bound
  passes" checked the last `getTransaction` read; the inner-hash read now comes after it. It now
  checks the last read of our own hash. Intentional.
- **The pool's late result found no record:** `resolved` looked the record up by `result.hash`,
  which for a rewrap is someone else's hash, not stored. It now uses `rewrap.of`.
- **The fake RPC answers carry no envelope**, so the normal landing path must not parse one:
  only the inner-hash path does.
- `postgres.test.ts`'s two migration-list tests name the new migration.

## Design Decisions

### From Plan

1. **Outer hash first, the inner hash once before `expired`** (okarcz, 2026-11-04): a rewrap is
   an edge case, so the normal path stays as it is, and the check is the smallest safety net.
   Chosen over reading by the inner hash everywhere and over leaving it to reconciliation alone.
2. **In the pool and in reconciliation, with a nullable `inner_hash` column** (okarcz,
   2026-11-04): a crash or RPC outage during a rewrap would otherwise still end `expired`. A hash
   stored before the column has none and is read by itself alone, as before.
3. **The record and the answer name the hash that landed** (okarcz, 2026-11-04): that one moved
   the money. Ours is `dead`, theirs is added last as `landed`.
4. **`feeCharged` 0 under someone else's fee bump** (okarcz, 2026-11-04): our fee account paid
   nothing, so 0024's budget counts nothing.
5. **A rewrap is logged and counted, `settlement_rewrapped`, with who paid** (okarcz, 2026-11-04):
   visible, but a warning, not an alarm. Replace-by-fee is allowed by the network and the payer
   paid what they signed, so it isn't necessarily malicious.

### Emerged

6. **Rewrap = a landed hash other than ours**, without comparing fee accounts: we sign one fee bump
   per inner transaction, and a rebuild has a new inner hash. Reconciliation then needs no signer
   address.
7. **The inner transaction sent bare counts as a rewrap too**, but keeps its `feeCharged`: the
   channel, our account, paid it.
8. **`onSigned`'s inner hash is optional in the type**: the pool always passes it, and the test
   stand-ins that call it with two arguments keep working.
9. **The inner read follows the history rule too** (okarcz, 2026-11-06, Adam's suggestion in the
   #128 review): `FallbackRpc` may send it to another node than the first read, and a node whose
   history starts after the envelope was built can't rule a rewrap out. It answers `pending`, as
   for our own hash, and reconciliation (`historyCovers`) finishes the record. Chosen over
   waiting a ledger and reading again, which helps only if the next read reaches another node.

## Review

2026-11-04, four layers (full mode): no decision, 7 patches applied, 1 deferred, 15 rejected.
Deferred: 0027's metrics and alarm lists don't name `settlement_rewrapped_total` (a warning, not an
alarm, decision 5), a note for 0027. Since done: `528c7c52` added it to the metrics catalog and
0027's `G-metrics.md`.

2026-11-06, Adam on #128: the inner read lacked the history check (decision 9, fixed in
`b031fc66`), and the `records.ts` comment still said a rewrap is logged twice (it is logged once,
by the write that made the record final, since `6a706edd`). Both fixed before the merge.
