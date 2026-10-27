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

## Acceptance Criteria

- [ ] Each failure's cause is named with evidence (a reproduction before and after the fix)
- [ ] Both test groups pass 50 looped runs under a simulated slow runner
- [ ] CI on develop is green
