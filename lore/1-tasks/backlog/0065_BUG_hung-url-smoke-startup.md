---
id: "0065"
title: "Make the hung-URL smoke runs start under the startup RPC check"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0061", "0045", "0051"]
tags: [facilitator, testnet, payments, priority-low, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: okarcz
    note: "Spawned from 0061 future work."
---

# Make the hung-URL smoke runs start under the startup RPC check

## Summary

0045's testnet runs point `RPC_URLS[0]` at a local server that never answers, to show `/verify`
and `/settle` failing over. Since 0051 (#58), `main()` checks every RPC URL's network before it
listens and exits with `startup_failed` when one doesn't answer, so that setup no longer starts.
PR #62 (0061) used a stub that answers `getNetwork` through a real RPC and hangs on every other
method. Make that the scripted way, so the failover smoke runs work again without hand setup.

## Implementation

- A small hung-RPC stub in `apps/facilitator/scripts/` that forwards `getNetwork` to a real RPC
  and never answers anything else, started by `settle-smoke.ts` and `verify-smoke.ts` when asked
  (or a documented command).
- Update both scripts' headers, which still describe a first URL that is hung from the start.

## Acceptance Criteria

- [ ] Given `settle-smoke.ts` with the stub as `RPC_URLS[0]` and a real RPC as `RPC_URLS[1]`, when
      it runs with `EXPECT_FAILOVER=1` in both bid modes, then the facilitator starts and every
      check passes, `failedOver` included
- [ ] Given `verify-smoke.ts` in the same setup, then it passes `failedOver` too
- [ ] Given the scripts' headers, then they describe the setup that works with the startup check
