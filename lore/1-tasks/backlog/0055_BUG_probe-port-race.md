---
id: "0055"
title: "Let mcp-local e2e and conformance servers pick their own port"
type: BUG
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0052"]
tags: [tests, ci, priority-low, effort-small, dev-tools]
links: []
history:
  - date: "2026-10-22"
    status: backlog
    who: karolkow
    note: "Spawned from 0052 future work."
---

# Let mcp-local e2e and conformance servers pick their own port

## Summary

`apps/mcp-local/e2e/src/seller.ts` (`freePort()`, used at `:28`) and
`conformance/test/proxy.test.ts` (`freePort()`, used at `:68`, `:208`, `:233`) pick a port by
listening on 0, closing, then handing the number to a server that starts later. Another connection
can take the port in between: Linux's outgoing range is 32768–60999, and CI runs package tests in
parallel. 0052 fixed the same race in the facilitator by letting the server listen on 0 and
reading the port back. No other probe-and-close helper is left in the repo (checked 2026-11-18).

## Context

- Only the conformance test races in CI: `pnpm test` runs `conformance`'s `test` script, while
  `apps/mcp-local/e2e` has only `test:testnet`, run by hand.
- Both servers refuse port 0 today, so this is not a test-only change:
  - `examples/http-api/src/config.ts` accepts `PORT` 1–65535 only, and `src/index.ts` logs the
    configured port, not the bound one.
  - `conformance/external-proxy/proxy.mjs` exits when `!port` (0 is falsy) and logs `${port}`.
- ADR 0009 says only that the harness sets `PORT` and waits for the line "Facilitator listening".
  If `proxy.mjs` takes 0 and logs the bound port in that line, the gate's contract is unchanged.
- The three uses in `proxy.test.ts` differ: `:68` (`startProxy`) is the race; `:208` wants a port
  where nothing listens, for the 502 "unreachable" test, so listening on 0 doesn't apply there;
  `:233` exits before it listens, so any fixed port works.

## Implementation

- `examples/http-api` and `proxy.mjs` accept `PORT=0` and log the port they bound.
- Each test starts its server on 0 and reads the bound port from the log line.
- `:208`: decide how the test gets an address that refuses connections, and record why it can't
  race; `:233`: a fixed port.

## Acceptance Criteria

- [ ] No test helper in the repo probes and closes a port to pass it on
- [ ] The affected tests pass; typecheck, lint and format clean
