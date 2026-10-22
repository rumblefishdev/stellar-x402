---
id: "0045"
title: "Fail over upstream verify across RPC_URLS before pubnet"
type: FEATURE
status: active
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
  - date: "2026-10-14"
    status: active
    who: okarcz
    note: "Work started while 0009 (PR #41) is in review."
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
- A local gate run on 2026-10-22 (0028 harness, PR #51 build, default single RPC URL) passed 14 of
  18: from 09:33 to 09:37 UTC `soroban-testnet.stellar.org` gave no answer within 10 s, so
  `/verify` and the checks inside `/settle` answered 500 three times. With one URL, failover has
  nowhere to go, so `deploy/testnet.env.example` lists more than one provider (decided
  2026-10-22). Public testnet RPCs on the Stellar providers page
  (developers.stellar.org/docs/data/apis/rpc/providers): SDF and Gateway answered
  `getLatestLedger` that day; Nodies' listed URL answered 404 on `/`.

## Implementation

- Options to weigh: one `ExactStellarScheme` per URL, tried in `FallbackRpc`'s order on
  `unexpected_verify_error` or the deadline; or an upstream change that accepts an `rpc.Server`.
- Keep the AD-10 bid and the AD-3 order unchanged.

## Acceptance Criteria

- [ ] Given `RPC_URLS` with a down first URL and a working second, when `/verify` is called, then it
      answers from the second URL, not with a 500
- [ ] The choice is recorded in spine AD-3
- [ ] Given `deploy/testnet.env.example`, when it is read, then `RPC_URLS` names at least two
      public testnet providers
