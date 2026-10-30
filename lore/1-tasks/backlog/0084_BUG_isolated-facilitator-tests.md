---
id: "0084"
title: "Give every facilitator test its own payment and its own clock"
type: BUG
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0074", "0025", "0019", "0009"]
tags: [facilitator, tests, ci, priority-medium, effort-medium]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: karolkow
    note: >
      Spawned from the CI failures seen on the 0063 PRs. The choice between the options below waits
      until 0063 is finished.
---

# Give every facilitator test its own payment and its own clock

## Summary

Facilitator tests fail now and then in CI (develop: 4 of the last 21 runs) because one test's
payment leaks into the next and because budget tests race a real database against a real clock.
Each test should own its record and its time, so it gives the same result on any machine.

## Context

- **One key for every test.** `payload()` in `apps/facilitator/test/payment.ts:34` signs with
  nonce `"7"` and a fixed payer, and all tests share one schema emptied by `beforeEach(db.empty)`.
  "ends a call at SETTLE_BUDGET_MS…" (`settle-pool.test.ts:266`) answers after 1.2 s while its
  account read takes 3 s; its call goes on, refuses in `onSigned` (`settle.ts:430`) and writes
  `record_write_failed` into the record the next test created under the same key. That is how
  "refuses a call that has signed nothing when the drain starts" (`settle-pool.test.ts:416`) gets
  `record_write_failed` instead of `shutting_down`. Not reachable in production: nothing deletes a
  record under a running call, and each payment has its own key.
  - **Measured 2026-10-30:** this leak is the cause. With a busy loop on each of 16 cores, the whole
    `settle-pool.test.ts` failed 6 of 6 runs; idle it passed 6 of 6. The drain test on its own nonce,
    or the leaking test skipped, passed 6 of 6 under load. (The tests have moved: the leaking test
    is now at `settle-pool.test.ts:325`.)
  - **This one leak's fix (0074, agreed, not applied):** end "ends a call at SETTLE_BUDGET_MS" with
    `await drain()`, which passed 8 of 8 under load. It stops this test only, so this task's own
    payment per test (options A, B) is still needed: any other test that ends before its call
    leaks the same way.
- **Two clocks.** The settle budget runs on the real clock and the store is real PostgreSQL, so on
  a slow runner the budget ends at another step than the test names. 0074's PR #76 moves the
  `settle budget (ADR 0011)` block to fake timers advanced 1 ms at a time once the pool is idle
  (`storeIdle`, `elapse`), and waits for late writes in an `afterEach`. Under the fake `Date`, its
  "not a hang" check `Date.now() - started < 1000` no longer measures anything.
- **macOS only.** "gives the lease up at once past a stalled client" (`settle-route.test.ts:494`):
  `stalled()` returns right after `socket.write`, before the server accepts the connection, and
  `server.close()` resets it. Waiting for the server's `connection` event makes it pass.
- Other tests that fail now and then and may share the first cause (not measured):
  "answers settlement_pending to a repeat…" and "attempt states… marks it sent" in
  `settle.test.ts`.
- Practice: M. Fowler, "Eradicating Non-Determinism in Tests" — isolate tests, wrap the system
  clock, wait on a signal rather than a sleep.

## Options

- **A — own payment, held steps, an injected clock.** A random nonce in `payload()`; a budget
  test holds the step it checks and moves the clock once the code waits there; the settler takes
  its clock as a parameter (a separate refactor PR). `storeIdle`, `elapse` and the `afterEach` go.
  About 3 h.
- **B — own payment only.** A random nonce in `payload()`; #76's fake clock stays, its `afterEach`
  goes. About 30 min.
- **C — #76 as is**, with the "not a hang" check measured by `performance.now()`. About 10 min.

## Acceptance Criteria

- [ ] An option is chosen and recorded here
- [ ] No test reads a record another test wrote: each payment in the facilitator tests has its own
      key
- [ ] The facilitator suite passes 50 runs in a row with PostgreSQL limited to 0.1 CPU
- [ ] "gives the lease up at once past a stalled client" passes on macOS
