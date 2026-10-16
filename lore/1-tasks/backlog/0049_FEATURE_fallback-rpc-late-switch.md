---
id: "0049"
title: "Fix FallbackRpc's switching: late answers, return to the first URL, URL-free logs"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0045", "0007", "0016"]
tags: [signer-pool, rpc, payments, priority-low, effort-medium]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-16"
    status: backlog
    who: claude
    note: >
      Spawned from 0045 future work (Adam's PR #45 review, C5): `FallbackRpc.call` has the
      late-switch pattern that 0045 fixed in the upstream verify failover.
  - date: "2026-10-16"
    status: backlog
    who: claude
    note: >
      Extended from Adam's second PR #45 review: no return to the first URL (lag in the AD-22
      read), endpoint names that are full URLs, no switch logs, and the A → B → A case.
---

# Fix `FallbackRpc`'s switching: late answers, return to the first URL, URL-free logs

## Summary

`FallbackRpc.call` (`packages/signer-pool/src/fallback-rpc.ts`) moves the active endpoint
whenever the endpoint that answered isn't the current one: `if (idx !== this.current)`. A call
that began on the old endpoint, before another call switched away from it, can answer late and
switch back. During a brownout that flaps the pool's and the ledger reads' traffic back to the
degraded endpoint, and `onSwitch` reports a switch for an endpoint that never failed. Switch only
when no other call has switched since this one began.

`FallbackRpc` also never returns to its first endpoint, names endpoints by their full URL, and
logs no switches. Fix those together, in the shape 0045 gave upstream verify's failover.

**Lane:** Payments

## Context

- 0045 fixed the same pattern in `failoverUpstream`, first with an index guard (decision 10). Adam
  then showed that an A → B → A sequence still lets a late answer switch back with that guard,
  so 0045 uses a switch counter captured at call start (decision 12). Use the counter here too.
- `sendTransaction` already switches only while the active endpoint is still the one it used
  (`this.current === from`), which has the same A → B → A hole.
- **No return to the first endpoint** (Adam, PR #45 second review, spine :92). Upstream verify now
  returns to `RPC_URLS[0]` after a payload-free probe (0045 decision 11); `FallbackRpc` stays on
  whichever endpoint last answered. The AD-22 ledger read in `/verify` goes through it, so a
  lagging fallback reports a lower ledger, and `/verify` accepts payloads with fewer real ledgers
  left than `MIN_VALIDITY_LEDGERS`, which `/settle` then refuses.
- **Names are full URLs** (`fromUrls` uses `name: url`). An RPC URL can carry an API key, so a
  name must never reach a log. ADR 0011 (as amended by 0009) logs RPC endpoints as `RPC_URLS[i]`,
  as 0045 does for upstream verify.
- **No switch logs**: `main()` passes no `onSwitch`, so a pool or ledger-read failover is
  silent, unlike upstream verify's `rpc_failover`.

## Implementation

- In `call()` and `sendTransaction`, capture a switch counter at call start, and switch only if
  it hasn't moved (0045 decision 12).
- Return to the first endpoint as 0045 decision 11 does: a `getLatestLedger` probe of endpoint 0
  every 60 s while off it, started beside a call, never inside one, and a return only within 2
  ledgers of the active endpoint.
- `fromUrls` names endpoints `RPC_URLS[i]`, and `main()` logs switches as `rpc_failover` with
  `component: "rpc"`, the network and a URL-free reason.
- Tests: the late answer, A → B → A, the probe's return and its lag guard, and a log with no URL.

## Acceptance Criteria

- [ ] Given a call that began on an endpoint before another call switched away from it, when it
      answers late, then the active endpoint doesn't change and `onSwitch` isn't called
- [ ] A signer-pool test covers it, and fails with the old condition
- [ ] Given calls on a fallback, when a probe finds endpoint 0 answering within 2 ledgers, then
      calls return to it; a probe that fails or lags keeps them on the fallback
- [ ] No `FallbackRpc` name or log line contains an RPC URL, and each switch is logged
