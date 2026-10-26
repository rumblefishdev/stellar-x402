---
id: "0025"
title: "Channel lease and graceful shutdown"
type: FEATURE
status: active
milestone: 1
related_adr: ["0006", "0011", "0012"]
related_tasks: ["0012", "0009", "0019", "0022", "0014", "0013", "0039"]
tags: [facilitator, signer-pool, operations, priority-high, effort-small, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.4 (Payments lane)."
  - date: "2026-10-26"
    status: active
    who: okarcz
    note: "Work starts, on top of 0019 (PR #57); rebased onto develop once #57 merges."
---

# Channel lease and graceful shutdown

## Summary

As a facilitator operator, I want only one process at a time to settle through a network's channel set, so that a deploy or a second instance never collides on channel sequence numbers.

**Story:** [M1 Story 2.4](../../../docs/planning/m1-epics.md#story-24-channel-lease-and-graceful-shutdown) · **Lane:** Payments · **Covers:** FR11 (AD-17); NFR9

## Context

- Deploys stop the old process before the new one starts (0014, 0026).
- Builds on the record lifecycle from 0019 so in-flight work is recorded before release.
- Related tasks: 0009, 0019, 0022.
- From 0019: `scheduleReconciliation` starts right after the server listens and sweeps every 10 s
  beside `/settle` (0019 decision 27: no 503 for reconciliation, no startup mode). Its writes stay
  correct without the lease (a record version guards expiry, decision 26), so it doesn't wait
  for the lease and sweeps in every process (0019 decision 37); the 503 here is for the lease
  alone. 0019 decision 10 (clock
  skew on `unsignedUntil`) assumes one lease holder.
- From 0019's code review: `Reconciliation.close()` stops the timer but doesn't wait for a sweep
  under way, and `main` ends the pools right after. That sweep's writes then fail and log
  `settlement_reconcile_failed` (the next start redoes it). The drain should wait for it, within
  its deadline, like the submissions below.

## Implementation

- Lease acquire, renew and release through the store port (fake first, real adapter from 0022).
- Shutdown handler that drains the pool.
- Tests for a second process, a crash and a clean stop.
- From 0039 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md), revised for the Hetzner server): a deploy stops the old
  container first. Docker sends SIGTERM, then SIGKILL after `stop_grace_period` 180 s. There's no
  load-balancer deregistration, so on SIGTERM the process itself:
  - answers new `/settle` with 503;
  - refuses at once every call not yet signed and sent: waiting for a channel, prepared ahead,
    or still reading a sequence. Nothing is sent; the record ends with its own reason,
    `settle_exact_stellar_shutting_down`, which this task adds to 0009's mapping, so the buyer
    signs a new payment and deploy cuts stay out of the no-channel metric. The pool can't cancel
    those today, so signer-pool needs a `close()` that rejects them;
  - lets only calls already sent run on: each answers within its `/settle` budget (0009), with
    the result or `settlement_pending` and the hash, while the drain follows the transaction;
  - waits until sent submissions are final or recorded as pending, then releases the lease.

  The drain lasts at most the pool's bounds for a sent transaction (60 s + 30 s), so the 180 s
  grace leaves about 90 s for the store writes and the lease release.
- From 0014: `GET /health` never looks at the lease. `/settle` answers 503 at once until the
  process holds the lease (since 0019 decision 27, not for reconciliation). A process without the
  lease keeps trying to take it and never exits; one whose renewal fails stops new submissions
  until it holds the lease again. The lease, not the deploy order, keeps two processes apart.
- From 0013 ([ADR 0012](../../../docs/adr/0012-facilitator-state-store.md)): decide whether
  `ChannelLease` carries a fencing token, so writes from a holder whose lease has expired are
  rejected. Without one, a paused holder can still write after a new one takes over. This is a
  contract change in the store port.
- From 0022: once `server.close()` runs, Node 22 stops enforcing `headersTimeout` and
  `requestTimeout`, so a client that stalls mid-headers keeps the server open indefinitely. With
  `STORE=postgres` the process was still running 137 s after SIGTERM, past the 120 s SIGKILL of
  the time (180 s now); a bare `http` server reproduces it. Cloudflare normally doesn't forward
  such clients, since it reads the whole request head first, but the drain and the lease release run
  after `close()`, so they need a deadline, e.g. `closeAllConnections()` once in-flight requests
  had their time.
- From 0022: `acquireLease` compares `expires_at`, stamped by the holder's clock, with the
  acquirer's `now`, so an acquirer whose clock runs ahead by more than the TTL takes a live lease,
  and both processes sign on the same channels until the holder's next renewal fails. The review
  recommends a fencing token together with a skew margin:
  - the margin (take over only once `expires_at + margin < now`) makes an early takeover rarer;
  - the token, raised on every acquire and checked in the same statement as `addHash`, stops a
    stale holder from sending anything new, since every send follows `addHash`;
  - `transition` stays unfenced, so a stale holder can still record what it already sent; what it
    doesn't record, the new holder's startup re-check resolves through the stored hashes. Its late
    transactions can still use a sequence number the new holder read, so expect `tx_bad_seq` and a
    sequence refresh.
- From 0009 (PR #41, decision 49): the config refuses `NETWORK=stellar:pubnet` until spend
  budgets (0024) and the channel lease (0025) land (rate limits, 0023, and store pruning, 0050,
  already have): the rule after the `STORE` one in `config.ts`, with tests in `config.test.ts`
  and `main.test.ts`. Whichever of the two lands last removes it; the other narrows its message
  to what is still missing, together with the facilitator README.
  - **0025 on that list is an assumption, not yet shown** (okarcz, 2026-10-20). The double-charge
    guard held without a lease: two `main()` instances on one database settled one payment once
    (Adam, sixth review). Find out what two processes on one channel set cost on pubnet: fees, a
    buyer charged and not served, or only `tx_bad_seq` rebuilds and slower answers. Then confirm
    the lease belongs in the refusal, or take it out.
- From 0009 (Adam's sixth PR #41 review): a submission that runs on after its budget answer
  writes to pools `close()` has ended. Reproduced: the transaction is sent, the row stays `signed`,
  and two `settlement_record_failed` lines are logged. Not a regression (0019 resolves the
  `signed` row through its hash), but the drain must wait for such submissions before the pools
  end. `compose()` doesn't return the `submitter` today; the drain needs it.
- From 0009 (PR #41, Adam's sixth review): a startup schema check, before `/settle` is served:
  every name in `MIGRATIONS` is in `schema_migrations`, and later ones are accepted (0026's note,
  so a rollback still starts). PR #41's release is the first to add a migration
  (`0002_success_answered`). Started on a database without it, it ran: every success was answered
  once per process instead of once per payment, because `markSuccessAnswered` failed with `42703`.

## Acceptance Criteria

- [x] Given a process starting, when it boots, then it takes an exclusive lease on its network's channel set through the store and keeps renewing it; without the lease it doesn't serve `/settle`
- [x] Given a second process for the same channel set, when it starts, then it can't take the lease and submits nothing
- [x] Given a shutdown signal, when the process stops, then it refuses new `/settle` calls, waits until every in-flight submission is final or recorded as pending, then releases the lease
- [x] Given a process that dies without releasing, when the lease TTL passes, then a new process can take the lease
- [x] Given a process without the lease, when `/settle` is called, then it answers 503 at once, and the process keeps trying to take the lease without exiting (ADR 0011)
- [x] Given a shutdown signal with calls still waiting for a channel, when the process drains, then those calls are refused unsent and the drain finishes within the 180 s stop grace period (ADR 0011)

## Implementation Notes

- **Lease keeper** (`apps/facilitator/src/settlement/lease.ts`): `createLeaseKeeper` returns
  `held()`, `start()`, `runOnce()` and `close()`. Each attempt renews a held lease or tries to
  take a free one, then the next comes `LEASE_TTL_MS / 3` after it ends. The lease is
  `<network>:channels`, the holder a new UUID for every process start. Logs `lease_acquired`,
  `lease_lost` (`reason`: `taken`, `expired` or `store_failed`) and `lease_acquire_failed`; counts
  `lease_changes_total{held}`.
- **`/settle`** (`http/app.ts`): a first handler answers `503 { error: "no_lease" }` with
  `Retry-After: 5` while `held()` is false, before the rate limit's store call and the body.
- **Wiring** (`main.ts`): `compose()` builds the keeper on the settlement store. `start()` makes the
  first attempt after the server listens and before the first sweep; `close()` stops it with the
  server. The lease isn't released yet: that comes with the drain.
- **Reconciliation** (`reconcile.ts`): `scheduleReconciliation` takes `held`, and a tick without the
  lease skips its sweep.
- **Tests:** `test/lease.test.ts` (11, memory store and a moved clock: one holder, renewal, a
  second process kept out, takeover after a crash's TTL, a renewal that finds another holder or a
  store error, a hung renewal, the timer and `close()`); a skipped sweep in `reconcile.test.ts`; the
  503 in `settle-route.test.ts`; two `main()` processes on one PostgreSQL database in
  `postgres.test.ts`, the second taking over once the first stops. Facilitator 535 → 549 with
  PostgreSQL. Mutants caught: `held()` always true, no local expiry, store errors ignored, a TTL/2
  interval.
- **Shutdown, signer-pool** (`submitter.ts`, `channel-pool.ts`): `SettlementSubmitter.close()` and
  `ShutdownError`. The pool refuses its waiters and every later `acquire()`; a call prepared ahead
  stops waiting behind the pending transaction, a sequence read stops retrying, and the check
  right before `onSigned` stops anything else, a `txBadSeq` rebuild included. Calls past `onSigned`
  run on. `close()` resolves once every `submit()` under way has returned. Refusals count as
  `refused.shutdown`.
- **Shutdown, facilitator:** `settle_exact_stellar_shutting_down` for a `ShutdownError` (the record
  closes `rejected`, `onFinal` runs); the settler's `drain()` waits for every submission and its
  record write, those past the budget answer included; `buildSettlement`'s `drain` closes the pool
  first. The keeper's `release()` stops it and deletes the lease row. `start()`'s `close()`: sets
  `closing` (`/settle` → `503 shutting_down`), stops the sweeps, drains, then closes the server and
  releases; past `SHUTDOWN_DEADLINE_MS` (150 s) it closes the server, cuts open connections and
  leaves the lease. Logs `shutdown_started`, `shutdown_drained`, `shutdown_deadline`,
  `lease_released`.
- **Shutdown tests:** `packages/signer-pool/test/shutdown.test.ts` (5: a queued call, one prepared
  ahead, a read retry, a rebuild, a `submit()` after `close()`; the sent call runs on and
  `close()` waits for it); the reason and the drain in `settle.test.ts`; a call refused during its
  sequence read through the real pool in `settle-pool.test.ts`; the drain order and the deadline
  in `settle-route.test.ts`; `release()` in `lease.test.ts`; the two-process PostgreSQL test now
  takes over within one attempt. Signer-pool 146 → 151, facilitator 549 → 556 with PostgreSQL.
  Mutants caught: no check before `onSigned`, a confirmation cut short by `close()`, queued
  waiters kept, a read retry not stopped (the loop then spins until the worker runs out of
  memory), no release after the drain, a release at the deadline, no shutdown reason, a no-op
  settle drain, no `shutting_down` 503, the drain skipped.

## Design Decisions

### From Plan

1. **A process without the lease serves and retries** (okarcz, 2026-10-26): HTTP listens at once,
   `/health` answers, `/settle` answers 503, and a background loop keeps calling `acquireLease`.
   It never blocks start or exits (ADR 0011).
2. **The holder renews every `LEASE_TTL_MS / 3`** (okarcz, 2026-10-26): about 10 s with the
   30 s default, so two renewals can fail or run slow before the lease runs out, and the interval
   follows the setting.
3. **A failed renewal stops new sends at once** (okarcz, 2026-10-26): a store error or `false`
   from `renewLease` both count as "no lease". `/settle` answers 503, calls already sent run on,
   and the loop keeps trying to take the lease again. Trusting the local expiry was rejected:
   another process's clock decides when it takes over.
4. **`/settle` reads an in-memory flag** (okarcz, 2026-10-26): a lease keeper owns the
   acquire/renew loop and the flag, so the check costs no store call. The flag is at most one
   renew interval stale; a lease lost between the check and the send is the fencing-token
   question.
8. **After SIGTERM `/settle` answers `503 shutting_down`** (okarcz, 2026-10-26): with `Retry-After`,
   like `no_lease`, but its own code, so logs and 0027's alerts tell a deploy from a lost lease.
9. **`close()` in signer-pool rejects every call that sent nothing** (okarcz, 2026-10-26): queued
   for a channel, prepared ahead or reading a sequence, and takes no new ones. `/settle` closes
   each record `rejected` with `settle_exact_stellar_shutting_down` and runs `onFinal`. A
   per-call abort signal was the alternative.
10. **The lease is renewed until the drain ends, then released** (okarcz, 2026-10-26): no other
    process sends while this one's transactions are in flight, and the next takes over within one
    attempt of the release.
11. **A drain past the process's own deadline leaves the lease to expire** (okarcz, 2026-10-26):
    before Docker's SIGKILL, the process force-closes open connections, ends the pools and exits
    without releasing, so a transaction still unresolved gets the TTL before another process sends
    on its channel. Releasing anyway was rejected.

### Emerged

5. **`held()` also ends at the expiry the process last wrote** (claude, 2026-10-26): measured on
   its own clock from the start of the call that wrote it. Without it, a renewal stuck in a hung
   store call would keep the flag up after the lease ran out and another process took it.
6. **A counter instead of a `lease_held` gauge** (claude, 2026-10-26): `Metrics` has counters only
   until 0027, so `lease_changes_total{held}` counts the changes; 0027 can derive the state or add
   a gauge.
7. **The first attempt comes before the first sweep** (claude, 2026-10-26): `start()` awaits it, so
   a process that takes the lease at once also sweeps at once instead of 10 s later. The server
   already listens, so `/health` answers meanwhile. `reconciled` settles after a skipped first
   sweep too, so tests of a process without the lease don't hang.
12. **The server listens until the drain ends** (claude, 2026-10-26): the checkpoint closed it
   beside the drain, but a closed server refuses new connections, so a client would get a refused
   connection (a 502 through the tunnel) instead of decision 8's `503 shutting_down`. It closes
   after the drain, or at the deadline.
13. **Only a call that sent nothing stops waiting on `close()`** (claude, 2026-10-26): the first
   version made every ledger wait end on `close()`, which cut a sent call's confirmation short and
   reported it `pending` at once; the shutdown tests caught it. `settlesBy` takes `untilClose`, set
   only for a call prepared ahead.
14. **No `/health` route yet** (claude, 2026-10-26): ADR 0011 names one, and the code has none; the
    shutdown tests use `GET /supported` to show the server still answers during the drain.
