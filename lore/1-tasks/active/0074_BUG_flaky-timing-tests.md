---
id: "0074"
title: "Make the timing-sensitive CI tests pass on a slow runner"
type: BUG
status: active
owner: karolkow
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
  - date: "2026-11-03"
    status: active
    who: karolkow
    note: >
      An architecture review measured what still fails: real budgets, not leaks.
  - date: "2026-11-05"
    status: active
    who: karolkow
    note: >
      Replanning how the settlement tests are built; first decisions recorded below.
---

# Make the timing-sensitive CI tests pass on a slow runner

## Summary

Two test groups depend on wall-clock deadlines and fail on a slow CI runner for reasons unrelated
to what they check. Each gets the cause measured and fixed in the test, not by longer timeouts in
production code.

## Premise

A fresh review attacked the premise on 2026-11-10, given only the goal, the measured failures and
the agreed constraints. Verdict: it holds with changes.

- The flakiness is real and current. Over every CI run from 2026-11-02 to 2026-11-10 (495 runs),
  49 failed; 36 of them on tests (40 failures, 17 distinct tests). About 3 in 4 are settlement
  tests on the real PostgreSQL database with a real budget of 100–300 ms or a store grace of
  20–200 ms, asserting one exact answer that holds only if the timer loses the race.
- The fake clock is flaky itself: two failures on 2026-11-10 ran inside `onFakeClock`
  (`settle.test.ts:635`, `:1550`). `vi.useFakeTimers` also fakes the database client's own timers.
- The clock is half injected already: `now` and `sleep` are deps, but `bounded` and `within` use
  the global `setTimeout` (`settle.ts:1230`, `:1246`). `src/timers.ts` has a `Scheduler` meant for
  tests. Passing it to the settler, with today's timers as the default, would leave the database on
  real time, drop `storeIdle`/`elapse`/`onFakeClock`, and change no behaviour. That reverses
  decision 9 for one structure-only change.
- The store grace is a second timer the budget rule does not cover: `markSuccessAnswered` is
  bounded by it even with seconds of budget left (`settle.ts:578`).
- Test budgets sit below what production allows (`SETTLE_BUDGET_MS` 1–80 s, `config.ts:227`).
- Decisions 5–7 and 11 are coverage and design work beyond the goal "CI green without hiding
  bugs".
- To simplify first: fold what `review-2-answers.test.ts` and `review-2-twice.test.ts` cover that
  `settle.test.ts` lacks, then delete both; warm ESLint in a `beforeAll` in
  `testing-imports.test.ts`.

Open for the owner: whether the settler takes a `Scheduler` before the test rewrite, whether test
timers come from the test's clock instead of short real values, and whether decisions 5–7 and 11
move to their own tasks.

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
- `apps/facilitator/test/settle.test.ts`, "drains a submission that runs on after its budget
  answer, with its record write (0025)" (the same race, a 50 ms budget): answered
  `settle_exact_stellar_timeout` instead of `settlement_pending` on `node (24)` in run 41445511672,
  and passed on `node (22)` on the same commit.
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
- Measured 2026-11-02 on `develop` `5a2ad44`, with #101 and #103 in, a busy loop on each of 10 cores:
  `settle`, `settle-pool`, `postgres`, `review-2-twice` and `mcp/pay` together, 50 runs: 49 clean.
  - Run 47 failed `settle.test.ts`, "never stores a hash for the earlier claim when another process
    ended and reopened it": its reopened call shared the real 100 ms budget. Reproduced with
    `addHash` delayed 150 ms (the record ends `rejected`, not `signed`); with a budget of its own the
    same delay passes.
  - `settle-route.test.ts`, "gives the lease up at once past a stalled client", failed every local
    run, also on `develop` `d11c956`: the server closed before it had read the client's bytes, when
    Node still counts the connection as idle (a plain `http` server: closed with no wait, kept after
    1 ms, 2 of 2). A request to the server now comes first. 5 of 5 runs pass with no load.
- The same 50 runs with both fixes and `settle-route`: 49 clean. Run 17 failed `settle.test.ts`,
  "reopens with exactly two ledgers left, the pool's floor", at the repeat's `success`.
  - Not reproduced: `settle.test.ts` alone passed 37 of 37 under the same load. A `store.get` or
    `markSuccessAnswered` delayed 300 ms doesn't fail it, so neither explains it. The answer itself
    wasn't kept, so the cause is open.
- Hunt for that failure, 2026-11-02, `develop` `98ef2f8`, the same load and files without `mcp/pay`, up to
  200 runs, keeping its answer: it never came back (0 of 200). Overall 186 of 200 clean; 14 failed, on
  10 other tests, 13 in `settle.test.ts` and 1 in `settle-pool.test.ts`. Their assertions show a
  call taking another path than the test names (`…_timeout` for `settlement_pending`, 2,567 ms for
  under 2,500), including the fake-clock block. Those failures fit 0084's cause (derived from the
  assertions, not measured per test); `develop`'s CI on `98ef2f8` failed on two of the same tests.

- Measured 2026-11-03 on `fa76af4`, `settle` and `settle-pool` (158 tests), 6 runs, 3 side by side, a
  busy loop on each of 10 cores, with a log of any store call by an earlier test's settler: 6
  failures, 0 with such a call during the failing test. All 6 ran on real budgets
  (`settle.test.ts:724` twice, `:468`, `settle-pool.test.ts:295` three times). Not random, harsher
  than the earlier load, and it can't show rare leaks.
  - CI, the 27 failed runs of the last 200: the drain test's leak failed 13 runs, the last before
    #101. After #101, 2 failed runs on 3 tests, all on a real budget, then 46 clean runs.
  - **Next:** of 13 real budgets outside the fake block, 2 use `onFakeClock`; move the other 11 (~2 h).
    0084 holds the per-test payment.
  - `settle-pool.test.ts:295`'s local failures may come from #102's real socket call under
    `AbortSignal.timeout`, which `storeIdle` can't see (assumption; no run without #102).

- Measured 2026-11-04 on `develop` `4ec5a72`, `settle` and `settle-pool`, 3 runs side by side, a busy
  loop on each of 10 cores: 6 of 12 runs failed, 9 failures on 4 tests. Three of the 4 aren't in the
  entries above: a 50 ms sleep before counting a wait's reads, and that test's call left running,
  which timed out the next test.
  - With #129 (tests wait for the step, not a fixed time): 1 of 30 runs failed. Not random, far
    harsher than CI, and 30 runs can't show rare failures.
  - **Open:** on the fake clock, a test that waits for its hash to be stored can hang until the test
    times out ("gives the success to the retry…" once in 30; "drains a submission…" 6 of 57, now on a
    real budget). Cause not found. With a log loop running beside it, 0 of 21 hung.
  - A real 1 s budget in "never says sign a new payment…" made it answer `success` in 16 of 30 runs,
    where 100 ms did in 5 of 30. Its first call running out of budget before the claim explains the
    100 ms case (derived), not the 1 s one (open). #129 moves its clock by hand.

- Measured 2026-11-09 on `develop` `51a73e2`, Stryker 10.1.1 on `settle.ts` only, 6 runners, 30 min, a
  loaded machine (load average about 50 on 10 cores, another suite running): 872 mutants, 700 killed,
  82 timed out, 74 survived, 16 not covered by any test. Of the 90 left, 26 change only a log line, a
  metric label or an error message. Among the rest: a client that left still has its success marked
  answered (`:1127`), a late result calls `onSuccess` though it is not a success (`:1141`), the
  `beforeSubmit` refusal writes without its claim guard (`:1104`), and a `payer_busy` wait does not
  wait for the other payment (`:1043`). A test that fails on timing marks a mutant killed, so the
  killed count may be high (not measured).
- On the same commit, with no mutants, `review-2-answers.test.ts` A3 failed in 1 of 2 full runs and
  passed 8 of 8 runs of its file alone.

- CI on `develop`, the 100 runs from 2026-11-05 10:18 UTC to 2026-11-09: 11 failed. Four failed typecheck
  (a code error, not timing). Seven failed a test: `settle.test.ts` "never stores a hash for the earlier
  claim…" once (it answered `success`), "answers the checks' refusal of a reopen…" once,
  `review-2-answers.test.ts` A3 twice, and `testing-imports.test.ts` three times, each a 5 s test
  timeout.
- CI on `develop`, the 23 runs from 2026-11-09 13:31 UTC to 2026-11-10 10:16 UTC: one failed
  (run 42784591712), a test not in the list above: `settle.test.ts` "never lets a waiting repeat
  end a claim reopened since it read the earlier one (0073 decision 19)". On a real 100 ms budget
  it answered `settle_exact_stellar_timeout` where it expects `settlement_pending`, so it is the
  same kind as the rest.

- Trial 2026-11-09 of one writer per claim (decision 11), local branch `lore-0074-one-writer-trial`,
  `settle.ts` +151/−87: after the claim only the claim's own submission writes; `/settle` and
  repeats read. Four new tests pass on real PostgreSQL; one, a hash write that outlasts the
  deadline, fails on `develop` (the answer names a hash nobody sends) and passes on the trial.
  The full suite, one run on a loaded machine: 24 of 1,011 failed, 10 in untouched files, about 8
  asserting today's write order, 3 lost behaviours (a success at the deadline answered pending; a
  store down at the budget answers pending with no hash; the next process's repeat no longer ends
  the old one's claim), 2 fake-clock timeouts, 1 not classified. The sweep and reopen still write,
  `settle.ts:1127` and `:1141` stay, and a test of "pending with the signed hash" still needs a
  real budget. Estimate to finish: 12–25 h, without folding in the sweep.

## Acceptance Criteria

- [ ] Each failure's cause is named with evidence (a reproduction before and after the fix)
- [ ] Both test groups pass 50 looped runs with a busy loop on every core
- [ ] CI on develop is green
- [ ] A fixed list of 10–15 seeded defects runs before and after the test rewrite, and its result
      is in the PR's evidence

## Decisions so far

| # | What is done | From | Vs the task | Who does the same (checked) | Code | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A test asserts the exact answer only where it sets the moment the budget ends. A test on real time asserts only money rules that hold in any order | grilling | beyond it | not checked upstream | — | — |
| 2 | The settlement and store tests stay on real PostgreSQL | grilling, ADR 0012 | matches | not checked upstream | — | — |
| 3 | No automatic test retries: a failed test gets its cause fixed | grilling | beyond it | none found in upstream's test configs | — | — |
| 4 | "Does not depend on time" means 50 clean runs with a busy loop on every core; such a test passes under any load | grilling, task AC | sharpens it | not checked upstream | — | — |
| 5 | A fixed list of 10–15 seeded defects, some the tests must newly catch: three such defects pass all 864 tests today | grilling, measured 2026-11-05 | beyond it | not checked upstream | — | — |
| 6 | Stryker runs on `settle.ts` before and after the test rewrite, on a local copy; the PR's evidence compares the two. Nothing of it enters the repo | grilling, measured 2026-11-09 | beyond it | not checked upstream | — | — |
| 7 | The four money-path gaps the mutation run found (`settle.ts:1127`, `:1141`, `:1104`, `:1043`) get tests in this task, on the seeded-defect list; a test that shows a real bug gets its fix in a PR of its own | grilling, measured 2026-11-09 | beyond it | not checked upstream | — | — |
| 8 | `review-2-answers.test.ts` A3 (a real 300 ms budget) and `testing-imports.test.ts` (over vitest's 5 s test timeout) are in this task, so "CI on develop is green" is reachable | grilling, measured 2026-11-09 | sharpens it | not checked upstream | — | — |
| 9 | This task changes test files only; the settlement code stays as it is | grilling | matches ("fixed in the test") | not checked upstream | — | — |
| 10 | A test helper refuses a real budget under 5 s unless the test sets the moment it ends; 5 s is an assumption, above the longest store delay measured under load (under 3 s) | grilling | beyond it | none found upstream | — | — |
| 11 | After the tests, a one-day trial on its own branch of one writer for the settlement record after it is created; its measured cost decides whether the rebuild goes on | grilling | beyond it | not checked upstream | — | — |
| 12 | When the budget ends while the store writes a hash, the hash the budget answer named is sent; any other, such as a rebuild's, is still refused. Found by the one-writer trial; fixed in its own PR (decision 7), amending 0009 decision 35 | grilling | beyond it | the hash is stored before the send and nothing cancels it once stored (checked in an open-source Stellar facilitator) | `settle.ts` `onSigned`, `outOfBudget` (#175) | `settle.test.ts`: sends the hash the budget answer named; refuses a rebuild's hash; store-outage send |

## Not yet decided

- Nothing open. How a test ends its budget and how the work splits into PRs follow the code and
  show in the PR report.

## Out of scope

- An in-memory store for tests (ADR 0012).
- Automatic test retries (decision 3).
