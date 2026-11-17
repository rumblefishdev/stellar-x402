---
id: "0090"
title: "After a deploy, don't send on a channel the last process left a transaction open on"
type: FEATURE
status: active
owner: okarcz
milestone: 2
related_adr: ["0011", "0006"]
related_tasks: ["0073", "0026", "0025"]
tags: [facilitator, signer-pool, deploy, before-pubnet, priority-high, effort-medium, payments]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR #85 review (Stan's question on the drain): needed before pubnet.
  - date: "2026-11-05"
    status: backlog
    who: karolkow
    note: >
      Added the question of what this leaves the rebuild after `txBadSeq` for.
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Payments lane, M2, priority high (okarcz, unlaned M1 check): the config refuses pubnet until it lands, and mainnet is prepared in M2.
  - date: "2026-11-17"
    status: active
    who: okarcz
    note: >
      Started: first of the quick, high-priority M2 Payments tasks.
---

# After a deploy, don't send on a channel the last process left a transaction open on

## Summary

The drain stops at 150 s, while since 0073 a sent transaction stays valid until the payer's auth
expires (about 426 s at the default). A deploy during traffic then leaves one open, and the new
process's sends on that channel may fail with `txBadSeq` and rebuild until it lands or expires:
minutes, not about 60 s. ADR 0011 records it; accepted for testnet, not for pubnet. The config
refuses `NETWORK=stellar:pubnet` until this task, per-key fee budgets
(0107), the signer alarm (0027) and the hot key's re-check (0048) land (0105 landed its part) (0024 decisions 12 and 31,
0036 decision 24): whichever lands last lifts the rule, the others
narrow its message (`config.ts`, 0071 decision 14).

## Implementation

- At startup, and until reconciliation ends them, the pool leaves out a channel whose record has
  a hash with a ledger bound not yet passed (the store holds both).
- A test across two processes: the second sends nothing on the held channel until the record
  ends, and uses the other channels meanwhile.
- Answer once this works: is the rebuild after `txBadSeq` still needed, and with it several hashes
  on one settlement record? The rebuild is the only source of a second hash. ADR 0003's load
  runs counted 0 sequence errors with one process, so this deploy overlap may be the only case
  left.
  Count `txBadSeq` in production first; if the rebuild has no case left, propose removing it.

## Acceptance Criteria

- [x] Given a transaction the previous process left open on a channel, when the new process
      takes the lease, then it sends on that channel only once the record is final
      (`channel-hold-takeover.test.ts` for the hold, `open-channels.test.ts` for the release)

## Implementation Notes

Branch `lore-0090-skip-channels-with-open-hash`.

- **`ChannelPool.hold(address, until)`** (`packages/signer-pool/src/channel-pool.ts`): keeps a
  channel from every caller until `until` settles, whether it is fulfilled or rejected. A free
  channel leaves the pool at once. A channel a caller holds is parked when that caller releases it.
  Holds stack. When the last one ends, the channel goes to the next waiter or back to the free list,
  with its sequence number cleared so it is read again. `handOver`, `release` and `retire` refuse a
  channel under a hold where it matters. `SettlementSubmitter.hold` exposes it, and a pipelined call
  doesn't hand over a held channel.
- **`createChannelHolder`** (`apps/facilitator/src/settlement/open-channels.ts`): `holdOpen()` lists
  the non-final records and their attempts. It holds every channel of ours with an attempt in
  `stored`, `sent` or `unknown` whose bound hasn't passed: `maxLedger` against the latest ledger,
  else `maxTime`, else the payer's auth expiry (`payerLedgerBound`, moved out of the reconciler).
  Each hold ends once every one of the channel's attempts is `landed` or `dead`, or its record is
  final. The store is re-read at the sweep interval (10 s). Logs `channel_held` (with the hashes)
  and `channel_freed`.
- **Lease** (`lease.ts`): an `onAcquired` step runs after the store grants the lease and before
  `held()` turns true. If it rejects, the acquire counts as failed (`lease_acquire_failed`) and the
  keeper tries again. `compose()` wires it to `holdOpen()`, and `drain` stops the holder.
- **The channel is stored with the hash** (`SignedBounds.channel` → `AttemptBounds.channel` →
  `addHash` writes `settlement_hashes.channel`). Until now an attempt got its channel only once it
  was final (`land()`, `markAttempts`), so an open attempt, the only kind 0090 needs, had none. The
  column already existed; no migration.
- **Pubnet gate:** 0090 is dropped from the `NETWORK` refusal in `config.ts` and from its tests.
  ADR 0011 says how the channel is held back.
- **Tests (run 2026-11-17: signer-pool 195/195, facilitator 1,130 passed and 3 skipped):** `channel-pool.test.ts` (hold: free, in use, ended before the
  release, stacked and rejected, unknown), `open-channels.test.ts` (which attempts hold, the release
  on `dead` and on a final record, the time bound, a failed store read at acquire and on a re-read),
  `lease.test.ts` (held only after `onAcquired`, a failed `onAcquired` retried) and
  `channel-hold-takeover.test.ts`: process 1's drain leaves a sent transaction on the first channel,
  and process 2 takes the lease, logs `channel_held` and settles on the second one. It fails with
  the hold switched off (it settles on the first channel). `settlement-guards.test.ts` now expects
  the channel in `onSigned`'s bounds.

## Design Decisions

### From Plan (okarcz, 2026-11-17)

1. **What holds a channel:** an attempt that may still land (`stored`, `sent`, `unknown`, bound not
   passed), not its record as a whole.
2. **Who checks:** the new process, when it takes the lease. The store is all the previous process
   leaves behind. The facilitator tells the pool; the pool never reads the store.
3. **What ends a hold:** reconciliation's answer, the attempt `landed` or `dead`.
4. **Every channel held:** callers queue as when all are busy, and get the same `QueueTimeoutError`
   answer at their deadline.

### Emerged (proposed by Claude, accepted by okarcz at the implementation checkpoint)

5. **The check runs on every acquire of the lease, and `held()` waits for it.** A deploy's new
   process usually takes the lease after the old one's drain, not at startup. Without the gate,
   `/settle` could take a channel before the read ends. A failed read fails closed.
6. **A final record ends the hold too.** `land()` marks only the attempt that landed and leaves the
   record's other attempts as they were, so waiting for them alone could hold a channel for good.
7. **The holder re-reads the store at the sweep interval** instead of hooking into the sweep: it
   reads the marks reconciliation writes and adds about 10 s at most.
8. **A hold on a channel in use applies at its release.** This covers re-acquiring the lease after
   losing it, when this process's own calls may still use the channel.

### Emerged (while implementing)

9. **The sequence number is read again after a hold.** At first only startup was meant, where it is
   never read yet. On a re-acquire the process may have read it before another process used the
   channel.
10. **An attempt with no bound of its own uses the payer's auth expiry**, as reconciliation does
    (`payerLedgerBound`). One with no readable bound at all is held, since reconciliation keeps it
    open too.
11. **No new metric**, only the `channel_held` / `channel_freed` logs. A metric would need the
    metric catalog, the alarm test and `docs/monitoring.md`.
12. **The channel is written with the hash, at `addHash`.** Found by the acceptance test: attempts
    carried no channel until final. Writing it at `onSent` instead would miss a process that died
    between storing and sending.
13. **The latest ledger is read only when an attempt is open.** A start with nothing open needs no
    RPC, so a down RPC doesn't keep the lease from being taken; found when main() tests on an RPC
    stub couldn't take the lease.

## Open

- The `txBadSeq` rebuild: per the task, count `txBadSeq` in production first; if nothing is left
  for the rebuild, propose removing it. Not decided here.
