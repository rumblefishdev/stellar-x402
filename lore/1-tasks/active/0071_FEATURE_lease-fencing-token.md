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
  - ../active/0025_FEATURE_channel-lease-and-shutdown.md
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

- A `token` column on `leases`, raised on every acquire by a new holder (a migration).
- `acquireLease` returns the token; the keeper keeps it, and `onSigned` passes it to `addHash`.
- `addHash` refuses when the lease's current token isn't the caller's, in the same statement; the
  pool then sends nothing (as for a final record today).
- Contract tests on both adapters, and a test with two processes where the first freezes past
  the TTL with a call between its lease check and `onSigned`.

## Acceptance Criteria

- [ ] Given a holder whose lease another process took, when one of its calls reaches `onSigned`,
      then `addHash` refuses it and nothing is sent
- [ ] Given the current holder, when it settles, then `addHash` works as before
- [ ] Given a stale holder with a transaction it already sent, when the transaction ends, then its
      record is still finished, by it or by the new holder's reconciliation
