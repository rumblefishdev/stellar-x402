---
id: "0055"
title: "Let mcp-local e2e and conformance servers pick their own port"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0052"]
tags: [tests, ci, priority-low, effort-small]
links: []
history:
  - date: "2026-10-22"
    status: backlog
    who: karolkow
    note: "Spawned from 0052 future work."
---

# Let mcp-local e2e and conformance servers pick their own port

## Summary

`apps/mcp-local/e2e/src/seller.ts` (lines ~10-27) and `conformance/test/proxy.test.ts` (lines
~40-61, used at ~193) pick a port by listening on 0, closing, then handing the number to a server
that starts later. Another connection can take the port in between: Linux's outgoing range is
32768–60999, and CI runs package tests in parallel. 0052 fixed the same race in the facilitator by
letting the server listen on 0 and reading the port back.

## Implementation

- Each server listens on 0, and the test reads the bound port from the server or its log line.
- Check first whether `run.sh` in conformance (ADR 0009) can take 0 and report its port; if not
  without a contract change, say so and leave that one.

## Acceptance Criteria

- [ ] No test helper in the repo probes and closes a port to pass it on
- [ ] The affected tests pass; typecheck, lint and format clean
