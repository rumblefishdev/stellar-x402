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

## Implementation

- Options to weigh: one `ExactStellarScheme` per URL, tried in `FallbackRpc`'s order on
  `unexpected_verify_error` or the deadline; or an upstream change that accepts an `rpc.Server`.
- Keep the AD-10 bid and the AD-3 order unchanged.

## Acceptance Criteria

- [x] Given `RPC_URLS` with a down first URL and a working second, when `/verify` is called, then it
      answers from the second URL, not with a 500
- [x] The choice is recorded in spine AD-3

## Implementation Notes

- **`settlement/upstream-failover.ts`**: `failoverUpstream(endpoints, { timeoutMs, onSwitch })`
  wraps one `UpstreamVerifier` per URL and fails over like `FallbackRpc`:
  - the call goes to the active endpoint, and on to the next when it throws, answers
    `unexpected_verify_error` or takes longer than `timeoutMs` (10 s);
  - the first endpoint with any other answer, a rejection included, becomes active;
  - if every endpoint fails, the first failure is the result (thrown, or the
    `unexpected_verify_error` answer), so `createVerifier` still answers 500.
- **`main.ts`**: `buildVerifier` builds one `upstreamAtCurrentBid` scheme per `RPC_URLS` entry
  inside `failoverUpstream`, with `UPSTREAM_TIMEOUT_MS` (10 s) per URL, and gives `createVerifier`
  an overall `upstreamTimeoutMs` of 10 s per URL.
- **`verify.ts`**: exports `UNEXPECTED_VERIFY_ERROR` and `withTimeout` for the failover module.
- **`config.ts`**: the `RPC_URLS` docstring now says upstream verify fails over too.
- **Spine AD-3**: the construction rule records one scheme per URL, the failover rule, the
  overall deadline and the Horizon limit; the 500 rule now says "on every URL".
- **Tests**: facilitator 103 → 113.
  - `upstream-failover.test.ts` (8): failover on `unexpected_verify_error`, a throw and a timeout;
    staying on the endpoint that answered; a rejection passed on without failover; wrap-around
    from the active endpoint; the first failure when every endpoint fails; no endpoints.
  - `build-verifier.test.ts` (+2): a down first URL answered from the second (AC 1), and a hung
    first URL plus a second that answers in 5 s, under fake timers.
  - Mutations caught: no failover on `unexpected_verify_error` (4 tests fail), always starting
    from the first endpoint (2), no per-endpoint timeout (3), an overall deadline of 10 s instead
    of 10 s per URL (1).
- Not run on testnet: the tests use fake schemes, as the other `buildVerifier` tests do.

**Modified tests:** `build-verifier.test.ts`'s `setup` takes an answer that may depend on the
scheme's RPC URL and may be a promise; the old "unexpected_verify_error" test now says "on every
RPC URL", since both URLs answer it.

## Issues Encountered

- **A stale `signer-pool` build in the main checkout** made typecheck and 6 test files fail
  (`FEE_STATS_MIN_STROOPS` missing). `pnpm install` and a rebuild of the workspace packages fixed
  it. Not a code problem.

## Design Decisions

### From Plan

1. **One `ExactStellarScheme` per URL, no upstream change** (okarcz, 2026-10-14). The other option,
   an upstream change that accepts an `rpc.Server`, would mean changing `@x402/stellar`.

### Emerged

2. **The failover sits outside `upstreamAtCurrentBid`**: one bid-aware scheme per URL, not one
   failover per bid. A new fee-stats bid then rebuilds only that URL's scheme, and the active
   endpoint survives the change.
3. **A rejection is never failed over.** Only a throw, a timeout and `unexpected_verify_error`
   say nothing about the payment. A lagging RPC can make a valid payment fail simulation; trying
   the next URL then would let a client shop for a verdict, so the verdict stands.
4. **`/verify`'s overall deadline is 10 s per URL** (20 s with two). The single 10 s deadline from
   0018 decision 18 would have cut off the second attempt.
5. **Endpoints are named `RPC_URLS[i]`, not by URL**, because an RPC URL can carry an API key
   (0018 decision 22). `onSwitch` exists, but `main.ts` doesn't log switches yet, as it doesn't
   for `FallbackRpc`.
6. **The Horizon read stays as it is.** Upstream reads the ledger close time from Horizon, with no
   URL of ours to fail over to. It falls back to its default on an error, but a Horizon that
   hangs takes every URL past its 10 s, and `/verify` then answers 500 after 10 s per URL.
   Recorded in AD-3; fixing it needs an upstream change.
7. **Built on develop, not on 0009.** 0009 (PR #41) renames `buildVerifier` to `buildChecks`; the
   upstream block moves across unchanged in the rebase, and `/settle`'s checks then fail over too.
