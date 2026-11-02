---
id: "0074"
title: "Make the timing-sensitive CI tests pass on a slow runner"
type: BUG
status: active
related_adr: ["0011"]
related_tasks: []
tags: [ci, tests, priority-medium, effort-small]
links:
  - https://github.com/rumblefishdev/stellar-x402/pull/74
history:
  - date: "2026-10-27"
    status: active
    who: karolkow
    note: >
      Two tests fail now and then in CI while passing locally, failing develop and unrelated PRs.
---

# Make the timing-sensitive CI tests pass on a slow runner

## Summary

Two test groups depend on wall-clock deadlines and fail on a slow CI runner for reasons unrelated
to what they check. Each gets the cause measured and fixed in the test, not by longer timeouts in
production code.

## Context

- `packages/mcp/test/pay.test.ts`, "does not send a payment whose signing outlasted the deadline":
  the check that the amount came back ran under the same 300 ms deadline as the late call, too
  short for a whole paid call on a slow runner (CI run 40497106902). Fix: PR #74.
- `apps/facilitator/test/settle.test.ts`, block "settle budget (ADR 0011)": four different tests
  failed with `Unexpected verification error: AxiosError: fetch failed` (develop runs 40338244923,
  40347628827; PR #71 run 40492496389). Cause being measured.
- Still on real time after #76, which moved only the "settle budget (ADR 0011)" block to a fake
  clock: "answers settlement_pending to a repeat once the settle timeout runs out" (outside that
  block) answered `settle_exact_stellar_timeout` instead of `settlement_pending` on PR #85's
  rerun (run 40911669720, job 123608719389): its 100 ms budget ran out before the hash was
  written.
- `apps/facilitator/test/settle-pool.test.ts`, "refuses a call that has signed nothing when the
  drain starts, and closes its record (0025)": answers `settle_exact_stellar_record_write_failed`
  where it expects `settle_exact_stellar_shutting_down` (PR #96, run 41052291836). It failed in
  3 of the 8 latest failed CI runs, and about half of local runs on the 0073 stack's base and on
  #92 (Adam, 5 of 10 each).
  - **Cause (measured 2026-10-30): a test leak, not a drain ordering bug.** "ends a call at
    SETTLE_BUDGET_MS" answers after 1.2 s while its 3 s account read goes on. All these tests share
    nonce `"7"`, so the leftover call's late `finish` lands in the record the drain test created
    after `db.empty`, as 0084 describes. The leftover call's claim matches because the record is
    new, which only a test can cause: production never deletes a record, and a reopen raises
    `reopened`, which every write of a call checks (0073 decision 24).
  - **Evidence:** the whole of `settle-pool.test.ts` with a busy loop on each of 16 cores: unchanged,
    6 of 6 failed (the same `record_write_failed`); no load, 6 of 6 passed. Under load, the drain test
    alone passed 8 of 8 and with only the leaking test 6 of 6, probably because the leftover call's
    3 s then ends after the drain test (not measured). With the drain test on its own nonce, or the
    leaking test skipped, 6 of 6 passed under load. So the call itself answers correctly.
  - **Fix:** "ends a call at SETTLE_BUDGET_MS" ends with `await drain()`, so its call is over before
    the next test. 0084's wider work stays separate.
- More failures on `develop` (7 of its last 14 runs, 2026-10-30), each fixed in the test:
  - `settle.test.ts`, "leaves a success from the pool's result…" and "answers settlement_pending
    to a repeat…": a real 100 ms budget ran out before the hash was written. The first call now
    runs on #76's fake clock (`onFakeClock`).
  - `settle.test.ts`, "never stores the earlier claim's late hash…": the repeat shared the first
    call's 100 ms budget, and now has a settler of its own.
  - `settle.test.ts`, "stores the hash with its bounds, marks it sent…": a 5 ms sleep raced a
    fire-and-forget write; it now waits for the state.
  - `review-2-twice.test.ts` B3: a 20 ms store grace dropped the first success mark.
  - `postgres.test.ts`: "rejects a hash another record's insert commits…" attached `.rejects`
    after `COMMIT`; "makes a takeover wait…" compared the arrival order of two connections, which
    says nothing about the database's. The check before `COMMIT` proves the wait.
  - `packages/mcp/test/pay.test.ts`, "gives the whole call one deadline…": 150 ms of slack missed
    by 54 ms, and an uncut call took only 1.2 s. Scaled up: a 2 s deadline, 1.2 s answers, 300 ms
    of slack, still below the 2.4 s of an uncut call.
  - Not reproduced or explained: "waits on close() for a settlement answered pending…" (once in 5
    full runs under load) and the failure of run 41079206183 (no annotation).

## Acceptance Criteria

- [ ] Each failure's cause is named with evidence (a reproduction before and after the fix)
- [ ] Both test groups pass 50 looped runs under a simulated slow runner
- [ ] CI on develop is green
