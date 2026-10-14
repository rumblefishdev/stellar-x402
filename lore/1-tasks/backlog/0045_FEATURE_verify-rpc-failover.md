---
id: "0045"
title: "Fail over upstream verify across RPC_URLS before pubnet"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0004", "0011"]
related_tasks: ["0018"]
tags: [facilitator, exact, payments, priority-medium, effort-small]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-14"
    status: backlog
    who: okarcz
    note: "Spawned from 0018 (Adam's PR #33 review): upstream verify reads only the first RPC URL."
---

# Fail over upstream verify across `RPC_URLS` before pubnet

## Summary

Upstream `ExactStellarScheme` takes one `rpcConfig.url`, so `/verify` uses only the first
`RPC_URLS` entry. While that endpoint is down, every `/verify` is a 500, although `FallbackRpc` (the
pool and our ledger reads) has a working fallback. Make `/verify` fail over too, before pubnet.

## Context

- 0018 builds upstream with `rpcUrls[0]` and answers its `unexpected_verify_error`, and any call
  past a 10 s deadline, with a 500. The `RPC_URLS` docstring says so.
- Upstream also reads Horizon for the ledger close time, with no failover and no timeout.

## Implementation

- Options to weigh: one `ExactStellarScheme` per URL, tried in `FallbackRpc`'s order on
  `unexpected_verify_error` or the deadline; or an upstream change that accepts an `rpc.Server`.
- Keep the AD-10 bid and the AD-3 order unchanged.

## Acceptance Criteria

- [ ] Given `RPC_URLS` with a down first URL and a working second, when `/verify` is called, then it
      answers from the second URL, not with a 500
- [ ] The choice is recorded in spine AD-3
