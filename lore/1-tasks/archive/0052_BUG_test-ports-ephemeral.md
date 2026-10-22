---
id: "0052"
title: "Start the facilitator in tests on a port the system picks"
type: BUG
status: completed
milestone: 1
related_adr: []
related_tasks: ["0022", "0051"]
tags: [facilitator, tests, ci, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-21"
    status: active
    who: karolkow
    note: >
      CI on PR #52 failed with EADDRINUSE on a fixed test port. Four facilitator tests listened on
      47129-47132; they now listen on PORT 0 and read the port back.
  - date: "2026-10-22"
    status: completed
    who: karolkow
    note: >
      PR #53 merged. Config accepts PORT 0; every facilitator test and both smoke scripts use it,
      including ports 47133-47136 that #41 and #54 added meanwhile. Facilitator 298 tests (369
      with PostgreSQL). Spawned 0055 for the same race in mcp-local e2e and conformance.
---

# Start the facilitator in tests on a port the system picks

## Summary

Four facilitator tests started the server on fixed ports, 47129–47132 (`test/main.test.ts`,
`test/postgres.test.ts`). Those ports are inside Linux's range for outgoing connections
(32768–60999), and CI runs every package's tests at once, so any connection in another test can
take the port first. CI on PR #52 failed that way: `listen EADDRINUSE: address already in use
:::47132`. Two test runs on one machine (two worktrees) collide on the same ports too.

**Lane:** Ops

## Decisions so far

| Situation | What happens | Date |
|---|---|---|
| `PORT=0` | Accepted: the system picks a free port, and the `listening` log line names it. Before, config refused it | 2026-10-21 |
| A test or script starts the facilitator | It sets `PORT=0`. A child process's test reads the port from the `listening` log line, `verify-smoke.ts` from `main()`'s result; the postgres tests never call the server | 2026-10-21 |

## Acceptance Criteria

- [x] No facilitator test listens on a fixed port
- [x] With ports 47129–47132 held by another process, the four tests pass (they failed on develop
      with `EADDRINUSE`)
- [x] `PORT=0` passes config; 70000 is still refused

## Issues Encountered

- **Why the ports were fixed:** `PORT` was bounded 1–65535 from the skeleton (0017, PR #7 review,
  "strict bounded numbers"), with no stated reason against 0. Tests then worked around it three
  ways: fixed ports for child processes (first in the PR #11 review), probe-close-pass in
  `verify-smoke.ts` (0018), and `port: 0` set after validation in the boot test. All three are gone.
- **New fixed ports while the PR was open:** #41 and #54 added 47133–47136 and a probe in
  `settle-smoke.ts`; each merge of `develop` moved them to `PORT=0`.

## Future Work

- The probe-close-pass race in `apps/mcp-local/e2e/src/seller.ts` and
  `conformance/test/proxy.test.ts` (0055).
