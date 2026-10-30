---
id: "0071"
title: "Fence the channel lease, so a stale holder sends nothing new"
type: FEATURE
status: active
milestone: 1
related_adr: ["0006", "0011", "0012"]
related_tasks: ["0025", "0022", "0013", "0024"]
tags: [facilitator, signer-pool, persistence, priority-high, effort-medium, payments]
links:
  - ../archive/0025_FEATURE_channel-lease-and-shutdown.md
history:
  - date: "2026-10-26"
    status: backlog
    who: okarcz
    note: "Spawned from 0025 (decision 15): due before pubnet."
  - date: "2026-10-29"
    status: active
    who: okarcz
    note: "Work started."
---

# Fence the channel lease, so a stale holder sends nothing new

## Summary

0025's lease keeps one process at a time on a network's channel set, but a process can still
send after it lost the lease: a call already past the lease check when its process freezes (a VM
pause, a long GC) longer than the TTL. Another process has taken over by then, and both sign on
the same channels. A fencing token makes the store refuse the stale holder's next `addHash`, and
every send follows `addHash`, so it sends nothing new.

## Context

- 0025 decisions 4, 5, 15: `/settle` checks an in-memory `held()` flag, which also ends at the
  expiry the process last wrote, so a frozen process starts no new `/settle` once it wakes. The
  window left is a call between that check and its `onSigned`.
- Its cost is `tx_bad_seq` and a sequence refresh on the channel both used, not a double charge:
  the settlement record still guards the payment (0019).
- From 0022's review and 0013 (ADR 0012): the token is raised on every acquire and checked in the
  same statement as `addHash`. `transition` stays unfenced, so a stale holder can still record
  what it already sent; what it doesn't, the new holder's reconciliation resolves through the
  stored hashes.
- Since 0025 decision 24 the config refuses `NETWORK=stellar:pubnet` until this task and 0024
  land: whichever lands last lifts the rule, the other narrows its message (0009's rule).
- 0025 decision 22 checks `held()` again right after `addHash`, so the window this task closes is
  that one write, or a process frozen past the TTL.
- 0025 decision 16 added a 5 s skew margin to `acquireLease`, which makes an early takeover rarer
  but doesn't stop a stale holder.

## Implementation

- A `token` column on `leases`, new on every acquire (a migration; decision 1).
- `acquireLease` returns the token; the keeper keeps it, and `onSigned` passes it to `addHash`.
- `addHash` refuses when the lease's current token isn't the caller's, in the same statement; the
  pool then sends nothing (as for a final record today).
- Contract tests on the adapter, and a test with two processes where the first freezes past
  the TTL with a call between its lease check and `onSigned`.

## Acceptance Criteria

- [x] Given a holder whose lease another process took, when one of its calls reaches `onSigned`,
      then `addHash` refuses it and nothing is sent
- [x] Given the current holder, when it settles, then `addHash` works as before
- [x] Given a stale holder with a transaction it already sent, when the transaction ends, then its
      record is still finished, by it or by the new holder's reconciliation

## Design Decisions

### From Plan

1. **Every acquire draws a new token, its own holder's re-acquire too** (okarcz, 2026-10-29): a
   renewal keeps it. Simpler than "only a new holder": one rule, fewer edge cases. Its cost: a
   process that lapsed and acquired again refuses its own call signed before the lapse, which
   then ends `…_lease_lost` and is retried; rare, since `held()` already stops most such calls.
   Chosen over keeping the token for the same holder.
2. **The token is `gen_random_uuid()`** (okarcz, 2026-10-29): the check is equality, so the token
   needs to be unique per acquire, not ordered, and nothing compares tokens by size (the network
   and OpenBao don't). A release deletes the row, so a counter kept in it would start over and
   repeat a stale holder's token. One column, no extra schema object. Chosen over a sequence
   (ordered, for "stale 7, current 9" in logs) and a counter on a row release no longer deletes.
3. **`addHash` gets the lease's name and token** (okarcz, 2026-10-29): the statement matches both,
   so a wrong network's token is refused too. Chosen over the token alone and over adding the
   holder (redundant: a new token already means a new acquire).
4. **A fenced call answers a new "nothing sent" reason, `settle_exact_stellar_lease_lost`**
   (okarcz, 2026-10-29): in `UNSENT_REASONS`, so it carries `extra.retryable` and the identical
   payload reopens it (0073). Also the answer of the `held()` checks around `addHash`, which
   answered `…_record_write_failed` ("sign a new payment") before. Chosen over reusing
   `…_interrupted` and over keeping `…_record_write_failed`.
5. **The stale call closes its record at once** (okarcz, 2026-10-29): `claimed → rejected` through
   the unfenced `transition`, atomic with `addHash`; nothing was stored, so it is safe. The payer
   gets an answer now. Chosen over leaving it to the new holder's sweep (`…_interrupted` after
   the budget plus 5 s).
6. **Stacked on #86** (okarcz, 2026-10-29): the reason joins #86's `UNSENT_REASONS` and its
   reopen, and the migration is `0007` after #86's `0006` (`0008` after #86's `0007` since 0073
   decision 27, #89 keeping `0006`). Chosen over waiting for #86 and over
   branching from develop and resolving the conflicts later.
7. **The lease row is locked in `addHash`'s statement** (proposed, okarcz confirmed at the
   implementation checkpoint): under Read Committed a plain read sees the token as of the
   statement's start, so a takeover committing meanwhile would let the hash through. With the
   lock, the takeover's update waits for the hash, or one that committed first is re-read and its
   new token refuses it. First `FOR SHARE`, then `FOR KEY SHARE` (decision 16).
8. **The `lease` argument is required** (proposed, confirmed): production can't skip the fence by
   forgetting it. Tests take a lease (`holdLease`) for `addHash` calls not about the lease.
9. **`addHash` throws `LeaseFencedError`** (proposed, confirmed), as it throws
   `HashConflictError`; `false` keeps meaning "final or missing". The fence comes before every
   other rule, a hash already on the record included.
10. **`settlement_lease_fenced` log line and `settlement_lease_fenced_total`** (proposed,
    confirmed): a call the store refused shows on the day it happens. A frozen process's own
    expiry usually stops the call first, with no such line (Adam's review of #92), so
    `settlement_outcomes_total` is what counts every `…_lease_lost`.
15. **A lease found lost right after the hash was stored still answers `…_lease_lost`** (okarcz,
    2026-10-29, review D1): the envelope wasn't sent, but the record has the hash, so it doesn't
    reopen and the answer carries the hash and no `extra`: sign a new payment, as for the other
    "nothing sent" reasons with a hash, which 0082 covers. Chosen over going back to
    `…_record_write_failed` for that path (a flag to tell the two checks apart) and over letting
    it reopen (0082's subject).
16. **`FOR KEY SHARE` and a unique `token`** (okarcz, 2026-10-29, review D2): with `FOR SHARE`,
    every renewal (an `UPDATE`) waited for every `addHash` in flight, each of which may wait on a
    record's lock, so a stalled write could cost the process its own lease. A renewal changes only
    `expires_at` and takes `FOR NO KEY UPDATE`, which `FOR KEY SHARE` doesn't block; a takeover
    changes the unique `token`, so it takes `FOR UPDATE` and still waits or is re-read, and a
    release (`DELETE`) still waits. Chosen over keeping `FOR SHARE` with the risk documented and
    over a `lock_timeout` on `addHash` (a new `…_record_write_failed` failure).

### Emerged

11. **A takeover by a release before 0071 keeps the token** (claude): its upsert doesn't set
    `token`, so during the one deploy that brings 0071 in, a stale new process could still store
    a hash after an old process took over. The old process is unfenced anyway, and pubnet stays
    refused until 0024. Written in the migration and the README; no fix.
12. **`onSigned` reads the lease before `addHash` too** (claude): with no lease held it throws
    before writing, so the record keeps no hash and reopens. The check after `addHash` (0025
    decision 22) stays, for an expiry that passed while the store wrote, and compares the token
    (review), so a lease acquired again during the write fences the call too (decision 1).
13. **`reasonFor` reads the `SignedHookError`'s `cause`** (claude): the pool wraps what `onSigned`
    threw, so `LeaseLostError` or `LeaseFencedError` as the cause maps to `…_lease_lost`; any
    other cause stays `…_record_write_failed`.
14. **The pubnet refusal names 0024 and 0090** (0025 decision 24, 0009's rule; Adam's review of
    #92, replacing "only 0024"): the README and 0090 say it is needed before pubnet, and naming
    0024 alone would let whoever closes 0024 open pubnet without it. Whichever lands last lifts
    the rule.

## Implementation Notes

- Migration `0007_lease_token` (renamed `0008_lease_token` when rebased onto #86's review fixes): `token uuid NOT NULL DEFAULT gen_random_uuid()` on `leases`.
- Port: `ChannelLease.token`, `LeaseFence` (`name`, `token`), `LeaseFencedError`, `addHash(key,
  hash, lease, updatedAt, bounds?, claim?)` with the fence as rule 0.
- Postgres: `acquireLease`'s takeover branch sets `token = gen_random_uuid()` and returns it.
  `addHash` adds a `fence` CTE (`SELECT … FROM leases WHERE name AND token FOR KEY SHARE`); the
  record's lock needs it, and the statement returns `fenced`. `token` is `UNIQUE` (decision 16).
- Keeper: keeps the token of its last acquire, `current()` gives `{ name, token }` while
  `held()`; a loss or release clears it.
- `/settle`: `SettlerDeps.lease` replaces `held`; `onSigned` passes it to `addHash`, logs and
  counts a fence, throws `LeaseLostError` when no lease is held. `SETTLE_REASONS.leaseLost` in
  `UNSENT_REASONS`. `main.ts` wires `lease.current`.
- Tests (facilitator 545 → 558): the token's rules (new on every acquire, kept by a renewal, new
  after a release); `addHash` under the current token, a replaced one, its own earlier one, a
  released lease, another lease's name, a resend after a takeover; `transition` after a
  takeover; the two lock races on PostgreSQL (a takeover waits for `addHash`; one committed
  first refuses it); the keeper's `current()`; `/settle`'s `…_lease_lost` with `retryable`, the
  fence's log and counter, a reopen under the new lease, and the task's frozen process: it reads
  its lease, freezes before the write, another process takes over, and nothing is stored or
  sent. Changed: the lost-lease test now expects `…_lease_lost` and no hash (the check runs
  before the write); the composed no-lease test expects `…_lease_lost`; the migration lists and
  the pubnet message.
- Mutants caught: no `FOR SHARE` (both race tests), the takeover keeping its token, the fence
  ignored, `reasonFor` ignoring the cause, `…_lease_lost` out of `UNSENT_REASONS`.

### Code review

- Four reviewers: 2 decisions (15, 16), 12 patches applied, 7 rejected (an invalid-uuid token,
  the `onSigned` timeout behind a takeover, the README row with an earlier hash, a fenced
  resend's `/settle` test, the fence log naming the new holder, decision 5's "atomic" wording
  twice). Report: the local review file for 0071.
- Patches: the re-check after `addHash` compares the token; `FOR KEY SHARE` and a unique token;
  the docs state the one envelope that can still go out after a takeover (stored and checked just
  before its process froze); spine AD-16 counts seven reasons; ADR 0012's open questions are
  decided; the README's `…_lease_lost` with a hash, and a pre-0071 process not reopening it during
  the deploy; `holdLease`'s doc; a stale pubnet comment; 0082 lists `…_lease_lost`.
- Tests (facilitator 558 → 564): the lease lost after the hash was stored (answered with it,
  nothing sent); the lease acquired again during the write; a renewal not waiting on `addHash`;
  a stale token through the real pool (nothing sent); `…_lease_lost` in the reason-mapping table
  and its written-out unsent list. Mutants caught: `FOR SHARE` back (the renewal test), no
  unique index (both race tests: a takeover then stops waiting), no token compare after the
  write, no check after the write.
- Decision 5's "atomic with `addHash`" means the stale call closes the record in its next write;
  a store failure there leaves it to the sweep, which closes it `…_interrupted`.
- Docs: the facilitator README (the lease section, the `…_lease_lost` row, "Nothing sent", the
  deploy gap, pubnet), ADR 0006 (amended 2026-10-29), ADR 0011, ADR 0012, spine AD-17.

### Adam's review of #92

- Decisions 1, 2, 15 and 16 confirmed; decision 14 replaced (pubnet names 0090 too).
- `…_lease_lost` with a `transaction` can also carry a hash that was sent and refused with
  `txBadSeq`, when the rebuild is fenced: text corrected, pinned through the real pool.
- An envelope stored before a freeze goes out once per call in flight and resends until its bound
  (the default cap's about 6.5 minutes, under one hash), since the send loop has no lease check.
- `settlement_lease_fenced` shows only a call the store refused (decision 10).
- Tests: another `onSigned` failure stays `…_record_write_failed` (a table row and `/settle`);
  `call.signing` moved below the lease check, so a budget answer can't name a hash the call
  never tried to store.
- Still to do: the testnet smoke once the stack lands; the last run was before the migration's
  rename.
