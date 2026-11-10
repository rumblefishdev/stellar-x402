---
id: "0025"
title: "Channel lease and graceful shutdown"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0006", "0011", "0012"]
related_tasks: ["0012", "0009", "0019", "0022", "0014", "0013", "0039", "0071", "0072", "0024"]
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
  - date: "2026-10-27"
    status: active
    who: okarcz
    note: >
      Rebased onto develop after PR #57 merged (sweeps no longer wait for the lease, decision 19;
      tests on PostgreSQL). Code review applied: the drain waits for a sweep under way, the
      process exits after its deadline, an end-to-end drain test, README corrections.
  - date: "2026-10-28"
    status: completed
    who: okarcz
    note: >
      PR #70 rebase-merged into develop (9d94077) after Adam's approval. His review applied:
      the lease checked again after addHash, released right after the drain, pubnet refused
      until 0024 and 0071, release always deletes its row, a second signal joins the drain,
      shutdown_failed logged (decisions 22-30). Facilitator tests 519, all green. Follow-ups:
      0071 (fencing token), 0072 (startup schema check).
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
  contract change in the store port. **Moved to 0071** (decision 15).
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
  - **Done:** the 5 s margin (decision 16). **The token moved to 0071** (decision 15).
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
  - **Done:** 0025 left the refusal, which now names 0024 alone (decision 17).
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
  **Moved to 0072** (decision 18).

## Acceptance Criteria

- [x] Given a process starting, when it boots, then it takes an exclusive lease on its network's channel set through the store and keeps renewing it; without the lease it doesn't serve `/settle`
- [x] Given a second process for the same channel set, when it starts, then it can't take the lease and submits nothing
- [x] Given a shutdown signal, when the process stops, then it refuses new `/settle` calls, waits until every in-flight submission is final or recorded as pending, then releases the lease
- [x] Given a process that dies without releasing, when the lease TTL passes, then a new process can take the lease
- [x] Given a process without the lease, when `/settle` is called, then it answers 503 at once, and the process keeps trying to take the lease without exiting (ADR 0011)
- [x] Given a shutdown signal with calls still waiting for a channel, when the process drains, then those calls are refused unsent and the drain finishes within the 180 s stop grace period (ADR 0011)

## Implementation Notes

- **Lease keeper** (`apps/facilitator/src/settlement/lease.ts`): `createLeaseKeeper` returns
  `held()`, `start()`, `runOnce()`, `close()` and `release()`. Each attempt renews a held lease or tries to
  take a free one, then the next comes `LEASE_TTL_MS / 3` after it ends. The lease is
  `<network>:channels`, the holder a new UUID for every process start. Logs `lease_acquired`,
  `lease_lost` (`reason`: `taken`, `expired` or `store_failed`) and `lease_acquire_failed`; counts
  `lease_changes_total{held}`.
- **`/settle`** (`http/app.ts`): a first handler answers `503 { error: "no_lease" }` with
  `Retry-After: 5` while `held()` is false, before the rate limit's store call and the body.
- **Wiring** (`main.ts`): `compose()` builds the keeper on the settlement store. `start()` makes the
  first attempt after the server listens and before the first sweep; the shutdown below stops it
  and releases the lease.
- **Reconciliation** (`reconcile.ts`): `scheduleReconciliation` took `held`, and a tick without the
  lease skipped its sweep. Removed in the rebase onto develop (decision 19). `close()` returns once
  a sweep under way has ended, so the drain waits for it (decision 20).
- **Tests:** `test/lease.test.ts` (13 with the later `release()` and margin cases, on PostgreSQL
  since the rebase, with a moved clock: one holder, renewal, a second process kept out, takeover
  after a crash's TTL, a renewal that finds another holder or a store error, a hung renewal, the
  timer and `close()`); the 503 in `settle-route.test.ts`; two `main()` processes on one PostgreSQL database in
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
  `closing` (`/settle` → `503 shutting_down`), stops the sweeps and waits for one under way beside
  the drain, then closes the server and releases; past `SHUTDOWN_DEADLINE_MS` (150 s) it closes the
  server, cuts open connections and leaves the lease. `server.ts` exits once `close()` settles
  (decision 21). Logs `shutdown_started`, `shutdown_drained`, `shutdown_deadline`,
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
- **Skew margin and pubnet:** `LEASE_SKEW_MARGIN_MS` (5 s) in `ports/settlement-store.ts`; the
  PostgreSQL adapter (the only one since 0064) takes another holder's lease only once it expired more than that ago, and the contract
  tests and the crash takeover in `lease.test.ts` move by it. The pubnet refusal names 0024 alone
  (`config.ts`, `config.test.ts`, `main.test.ts`, README).
- **Code review (2026-10-27):** decisions 20 and 21; an end-to-end drain test in
  `settle-pool.test.ts` through `compose()` and `start()` (a payment answered `settlement_pending`
  keeps `close()` open until it lands, and its record is `success` when the lease is released); a
  sweep drained in `settle-route.test.ts`; `close()` waiting for a sweep in `reconcile.test.ts`.
  README: no `/health` route yet, the deadline's real bound (about 25 s, not the TTL; 0071), the
  503 and the 200 `…_shutting_down` told apart, that row's `transaction`. Facilitator 513 → 515
  with PostgreSQL; mutants caught: no settle drain, no `drain` dependency, `drain` not awaited,
  `close()` not waiting for the sweep, `start().close()` not waiting for it. The process exit has
  no test, since it needs the 150 s deadline.
- **Modified tests in the review round:** the shutdown refusal in `settle-pool.test.ts` waits for
  the account read instead of a fixed 50 ms; the shared-read bound in `settle.test.ts` (from 0009)
  is 150 instead of 70, since the tests' PostgreSQL spreads the initial lookups (CI read 73;
  unshared reads come to about 550). Intentional.

## Issues Encountered

- **Timers starved by a fast fake RPC**: the end-to-end drain test hung until `FakeRpc`'s ledger
  reads were delayed 20 ms; with instant reads the pool's wait never let a timer run. Test-only.
- **Timing on a loaded runner**: the shared-read bound test failed on CI and got more room
  (8e086b4). On PR #70's last push, node 22 failed once in `settle-pool.test.ts` ("refuses a call
  that has signed nothing when the drain starts": `record_write_failed` instead of
  `shutting_down`); it passed on rerun and 5/5 locally. A candidate for 0074.
- **Rebase onto develop**: 0019's decision 37 took `held()` off the sweeps, so the rebase dropped
  that wiring and its test, and the memory-store tests moved to PostgreSQL (0064).

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
    *Corrected 2026-10-27 (code review):* the TTL runs from the last renewal, so another process
    can send about 25 s after the deadline (TTL less up to a third, plus the 5 s margin), while a
    transaction can stay valid for 60 s. The cost is `tx_bad_seq` and a rebuild, not a double
    charge; 0071's fencing closes it.
15. **The fencing token is a backlog task, 0071, due before pubnet** (okarcz, 2026-10-26): on one
    host with `held()`'s local expiry, the window left is a call already past the lease check when
    its process freezes past the TTL, and its cost is `tx_bad_seq`, not a double charge. The port
    change and its migration get their own review.
    *Corrected 2026-10-28 (Adam's PR #70 review):* the window was wider: a call checked the lease
    only on arrival, so one let in before a DB failover could send minutes later, after the lease
    was lost, with no frozen process. Decision 22 narrows it to one `addHash`.
16. **An acquirer takes over only 5 s after `expires_at`** (okarcz, 2026-10-26): a skew margin
    against a holder whose clock lags, for the day the facilitator runs on two hosts. A clean
    release deletes the row, so only a crash's handover waits the extra 5 s.
17. **0025 leaves the pubnet refusal** (okarcz, 2026-10-26): the lease and the drain landed, as
    0009's rule expects, so the message names spend budgets (0024) alone. PR #66 (0054) had
    already taken its decision off the path; the fencing window goes with 0071.
    *Replaced by decision 24.*
22. **The lease is checked again once a hash is stored** (okarcz, 2026-10-28, Adam's PR #70
    review M1): `createSettler` takes `held`, and `onSigned` throws right after `addHash` when it
    is false, like the budget check, so the pool doesn't send that envelope. A call let in before
    the lease was lost (body upload, the wait for a channel) then sends nothing on channels another
    process may own; what is left is one `addHash`, which 0071 fences.
23. **The lease is released once the drain ends, before the server closes** (okarcz, 2026-10-28,
    Adam's review M2): after `submitter.close()` and `settle.drain()` nothing can send, and sweeps
    need no lease (decision 19). Then, under the deadline: `server.close()`,
    `closeIdleConnections()`, a grace for open requests, `closeAllConnections()`, and the wait for
    a sweep under way. One stalled client used to keep `server.close()` open to the deadline, so
    the lease ran out instead of being released: about 3 minutes without `/settle`. Replaces the
    order in decision 10 and emerged decision 12 (still listening during the drain stays).
24. **Pubnet stays refused until spend budgets (0024) and the lease fencing token (0071) land**
    (okarcz, 2026-10-28, Adam's review M3): naming 0024 alone would have let whoever closes 0024
    open pubnet without fencing, against decision 15. 0009's rule stays: whichever lands last
    lifts it, the other narrows the message. Config, tests, README and the 0024 note updated.
25. **`release()` always deletes its own row** (okarcz, 2026-10-28, Adam's review): a renewal that
    failed on a store error clears the flag, but the row may still be ours, so the next process
    used to wait TTL + 5 s after a clean shutdown. The delete names the holder, so it is safe; only
    the `lease_released` log and the metric still need the flag.
26. **A second SIGTERM or SIGINT joins the drain** (okarcz, 2026-10-28, Adam's review):
    `process.on` instead of `once`, as `main()`'s `close` is memoized. With `once`, a repeated
    signal fell to Node's default and killed the process mid-drain, without the release.
27. **A failed shutdown is logged** (okarcz, 2026-10-28, Adam's review): `shutdown_failed` with
    the error, URLs redacted, then exit code 1.
18. **The startup schema check is its own backlog task, 0072** (okarcz, 2026-10-26): it concerns
    migrations, not the lease.

### Emerged

5. **`held()` also ends at the expiry the process last wrote** (claude, 2026-10-26): measured on
   its own clock from the start of the call that wrote it. Without it, a renewal stuck in a hung
   store call would keep the flag up after the lease ran out and another process took it.
6. **A counter instead of a `lease_held` gauge** (claude, 2026-10-26): `Metrics` has counters only
   until 0027, so `lease_changes_total{held}` counts the changes; 0027 can derive the state or add
   a gauge.
7. **The first attempt comes before the first sweep** (claude, 2026-10-26; the sweep part is
   moot since decision 19, the order stays): `start()` awaits it, so a process that takes the
   lease at once also sweeps at once instead of 10 s later. The server already listens, so
   `/verify` and `/supported` answer meanwhile.
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
19. **Sweeps don't wait for the lease** (okarcz, 2026-10-27, Stan's PR #57 review, 0019 decision
    37): the rebase onto develop drops `held` from `scheduleReconciliation` and `buildSettlement`
    and its skipped-sweep test. A process waiting for the lease, for example after a crash, then
    finishes payments that landed at once; every sweep write is a compare-and-set on the version.
    The same rebase moves the lease and shutdown tests to PostgreSQL (0064 dropped the memory
    store), and the timer test waits for each renewal, since the queries take real time.
20. **The drain waits for a sweep under way** (claude, 2026-10-27, code review): the Context item
    from 0019's code review. `Reconciliation.close()` returns once the running sweep ends, and
    `start().close()` waits for it beside the settlement drain, so its writes don't reach the
    pools `main()` ends next.
21. **The process exits once `close()` settles** (claude, 2026-10-27, code review): past the
    deadline, confirmations still under way kept it alive until Docker's SIGKILL, though decision
    11 says it exits. `server.ts` calls `process.exit()` after `close()`, with code 1 if it
    failed.

28. **The grace after the drain is 15 s, `SHUTDOWN_GRACE_MS`** (claude, 2026-10-28): decision 23
    left it open. A `/verify` on one RPC URL takes up to its 10 s timeout plus slack; one walking
    several URLs past 15 s is cut. A test seam `shutdownGraceMs` sits beside `shutdownDeadlineMs`.
    Past the deadline with only a sweep left, `close()` logs `shutdown_deadline` with
    `drained: true` and returns; the deadline log of an unfinished drain has `drained: false`.
29. **A call that finds the lease lost answers `settle_exact_stellar_record_write_failed`**
    (claude, 2026-10-28): the hook's throw is a `SignedHookError` like the other `onSigned`
    refusals, so the answer is that row ("a new envelope wasn't sent"), its README text extended
    with the lost lease. A code of its own was not added: the client's next step, a new payment,
    is the same. The hash stays on the rejected record, never sent.
30. **`shutdown_failed` goes through a fresh `jsonLogger("error")`, not bare `console.error`**
    (claude, 2026-10-28): it redacts every URL like `startup_failed` in the same file, and it
    doesn't depend on `main()`'s logger. A failed start reached by a signal sets exit code 1
    without a `shutdown_failed` line; `startup_failed` already covers it.

**Modified tests (2026-10-28):** the route test "drains a reconciliation sweep under way before it
gives the lease up" now expects the release before the sweep ends, and `close()` to wait for it
(decision 23). The lease test "releases nothing it doesn't hold" became "deletes only its own row
when it holds nothing" (decision 25). The deadline test now opens a stalled socket and checks it
is cut, so removing `closeAllConnections()` fails it. New: lease lost before `onSigned`
(`settle.test.ts`), release past a stalled client and cut after the grace
(`settle-route.test.ts`), release after a failed renewal (`lease.test.ts`). `server.ts` (decisions
26, 27) has no test, as before.

## Future Work

- **0071**: fence the lease with a token checked in `addHash`, before pubnet.
- **0072**: refuse to start on a database missing a migration.
