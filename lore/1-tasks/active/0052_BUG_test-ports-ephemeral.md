---
id: "0052"
title: "Start the facilitator in tests on a port the system picks"
type: BUG
status: active
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
