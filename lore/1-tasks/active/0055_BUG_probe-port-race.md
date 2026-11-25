---
id: "0055"
title: "Let mcp-local e2e and conformance servers pick their own port"
type: BUG
status: active
owner: bstruzyk
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
  - date: "2026-11-24"
    status: active
    who: bstruzyk
    note: "Started."
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

- [x] No test helper in the repo probes and closes a port to pass it on (`git grep freePort` finds
      none outside lore)
- [x] The affected tests pass; typecheck, lint and format clean (`examples/http-api` 14 tests,
      `conformance/test/proxy.test.ts` 17 tests; `apps/mcp-local/e2e` typechecks, its testnet run
      is by hand)

## Implementation Notes

- `examples/http-api`: `PORT` takes 0–65535; `src/index.ts` logs `server.address().port`. Config
  test for 0 flipped from refused to accepted; README's `PORT` row says what 0 does.
- `conformance/external-proxy/proxy.mjs`: `PORT` must be digits up to 65535 (0 allowed, unset or
  empty still refused); the "Facilitator listening on port N" line names the bound port, so ADR
  0009's contract with the suite is unchanged.
- `conformance/test/proxy.test.ts` and `apps/mcp-local/e2e/src/seller.ts` start their server on 0
  and read the port back from the start line; both `freePort()` helpers are gone.
- From the PR #239 review: each refusal row also expects the proxy's message on stderr, since an
  uncaught error exits 1 too (`listen(70000)` throws `ERR_SOCKET_BAD_PORT`). The seller's start
  line, which the e2e now depends on, is checked in `pnpm test` by
  `examples/http-api/test/index.test.ts`: it starts `src/index.ts` through tsx on `PORT=0`, reads
  the port with `seller.ts`'s pattern and expects a 402 there.

## Design Decisions

### From Plan

1. **Servers listen on 0 and report the bound port** in the line the harness already waits for, as
   0052 did for the facilitator.

### Emerged

2. **The 502 test uses a facilitator that drops each connection**, a `net` server on 127.0.0.1:0
   held for the whole file whose handler destroys the socket. The proxy's `fetch` fails the same
   way as for a refused connection, and the port stays bound by the test, so nothing else can take
   it and answer. A refused port can't be had without a probe-and-close (a TCP port can't be bound
   without listening), and a `.invalid` host depends on the resolver answering quickly.
3. **The refusal test uses `PORT=0`, not a fixed port**: the proxy exits before it listens, and 0
   can't collide with anything even if it didn't. It became a table that also covers an unset, a
   non-numeric and an out-of-range `PORT`, since the proxy's check changed from `!port`.
4. **The port is read only once the character after it has arrived** (`,` in the proxy's line,
   `/` in the seller's): stdout can come in chunks cut mid-number, and a bare `(\d+)` would
   take `543` of `54321`. 0052's `listeningPort` guards the same way by parsing whole lines only.

