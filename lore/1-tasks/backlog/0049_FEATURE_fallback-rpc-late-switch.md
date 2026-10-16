---
id: "0049"
title: "Stop FallbackRpc switching back on a late answer"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0045", "0007", "0016"]
tags: [signer-pool, rpc, payments, priority-low, effort-small]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-16"
    status: backlog
    who: claude
    note: >
      Spawned from 0045 future work (Adam's PR #45 review, C5): `FallbackRpc.call` has the
      late-switch pattern that 0045 fixed in the upstream verify failover.
---

# Stop `FallbackRpc` switching back on a late answer

## Summary

`FallbackRpc.call` (`packages/signer-pool/src/fallback-rpc.ts`) moves the active endpoint
whenever the endpoint that answered isn't the current one: `if (idx !== this.current)`. A call
that began on the old endpoint, before another call switched away from it, can answer late and
switch back. During a brownout that flaps the pool's and the ledger reads' traffic back to the
degraded endpoint, and `onSwitch` reports a switch for an endpoint that never failed. Switch only
when no other call has switched since this one began.

**Lane:** Payments

## Context

- 0045 fixed the same pattern in `failoverUpstream` (decision 10): a call keeps the active index
  it started with, and switches only if the active endpoint is still that one.
- `sendTransaction` already switches only while the active endpoint is still the one it used
  (`this.current === from`).

## Implementation

- In `call()`, keep `start` and switch only when `idx !== start && this.current === start`.
- Test: two concurrent calls, the first answering late on endpoint 0 after the second switched to
  1; the active endpoint stays 1 and `onSwitch` runs once.

## Acceptance Criteria

- [ ] Given a call that began on an endpoint before another call switched away from it, when it
      answers late, then the active endpoint doesn't change and `onSwitch` isn't called
- [ ] A signer-pool test covers it, and fails with the old condition
