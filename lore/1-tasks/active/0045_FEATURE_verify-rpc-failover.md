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

- **`settlement/upstream-failover.ts`**: `failoverUpstream(endpoints, { timeoutMs,
  primaryRetryMs, onSwitch })`, with its own active endpoint, separate from `FallbackRpc`'s:
  - `endpoints()` is read once per call, before any endpoint's timer starts; in `main.ts` it reads
    the bid and returns one scheme per URL built for it (decision 8);
  - the call goes to the active endpoint, and on to the next when it throws, answers
    `unexpected_verify_error` or takes longer than `timeoutMs` (10 s);
  - the first endpoint with any other answer, a rejection included, becomes active, unless
    another call switched since this one began (decision 10);
  - after `primaryRetryMs` (60 s) off the first endpoint, one call tries it first again
    (decision 9);
  - the answering endpoint's name goes in `trace.rpc`;
  - if every endpoint fails, the first failure is the result (thrown, or the
    `unexpected_verify_error` answer), so `createVerifier` still answers 500.
- **`main.ts`**: `buildUpstream(config, fees, logger, makeScheme?)` returns `{ upstream,
  upstreamTimeoutMs }` together (decision 7): one scheme per `RPC_URLS` entry per bid
  (`atCurrentBid`), `UPSTREAM_TIMEOUT_MS` (10 s) per URL, each switch logged as `rpc_failover`
  (`from`, `to`), and the deadline from `upstreamDeadlineMs` (decision 4). `buildVerifier` spreads
  it into `createVerifier`'s deps.
- **`fees.ts`**: `atCurrentBid(inclusionFee, build)` replaces `upstreamAtCurrentBid`: it reads the
  bid and returns what `build` made for it, built again only when the bid changes.
- **`verify.ts`**: exports `UNEXPECTED_VERIFY_ERROR` and `withTimeout` for the failover module.
  `UpstreamVerifier.verify` and `Verify` take an optional `VerifyTrace` that the failover fills in
  with `rpc`; `upstreamTimeoutMs` is documented as the whole upstream call's deadline.
- **`http/app.ts`**: the `verified` log carries `rpc`, the `RPC_URLS[i]` that answered.
- **`config.ts`**: the `RPC_URLS` docstring says the URLs are tried in order and that upstream
  verify returns to the first after 60 s, instead of calling the first "primary".
- **Spine AD-3**: the construction rule records one scheme per URL, the failover rule, the
  `rpc_failover` log, the overall deadline, the lagging-RPC risk, the fee-stats read inside each
  URL's 10 s and the Horizon limit; the 500 rule now lists the three ways every URL can fail.
- **Tests**: facilitator 103 → 113, then 125 after the PR #45 review.
  - `upstream-failover.test.ts` (8): failover on `unexpected_verify_error`, a throw and a timeout;
    staying on the endpoint that answered; a rejection passed on without failover; wrap-around
    from the active endpoint; the first failure when every endpoint fails; no endpoints.
  - `build-verifier.test.ts` (+2): a down first URL answered from the second (AC 1), with the
    `rpc_failover` warning, and a hung first URL plus a second that answers in 5 s, under fake
    timers.
  - Mutations caught: no failover on `unexpected_verify_error` (4 tests fail), always starting
    from the first endpoint (2), no per-endpoint timeout (3), an overall deadline of 10 s instead
    of 10 s per URL (1).
- **PR #45 review** (Adam, 2026-10-15, C1–C6, all fixed):
  - C1, the deadline sits outside the upstream block that moves to #41's `buildChecks`:
    `buildUpstream` returns both (decision 7);
  - C2, a healthy URL timed out while `FallbackRpc` served the bid read from a hung URL:
    the bid is read before the loop (decision 8);
  - C3, the failover never came back to `RPC_URLS[0]`, so a lagging fallback answered silently:
    `rpc` in the `verified` log, the 60 s return and the lag risk in AD-3 (decision 9);
  - C4, the tests listed below;
  - C5, a late answer on the old URL switched back (decision 10);
  - C6, the doc fixes: AD-3's deadline wording, the separate active URL, the Horizon note, the
    `upstreamTimeoutMs` docstring, the test comment, and this note's smoke run.
  - New tests (`upstream-failover.test.ts` 8 → 15, `build-verifier.test.ts` +5, `fees.test.ts`,
    `verify-route.test.ts` +1): rejections table-driven over `…_simulation_failed` and
    `…_signature_expiration_too_far`; a rejection makes its URL active; a late answer after
    another call switched; the 60 s return, once per interval; the endpoints read before the
    timers; both URLs hanging (`UpstreamTimeoutError` within 10,000 ms); a first URL that throws;
    a 10 s fee-stats read without failover; `upstreamDeadlineMs`; the trace and the `rpc` log.
    Test times derive from `UPSTREAM_TIMEOUT_MS`.
  - Mutants caught (each fails 1–7 tests): Adam's four (failover on `…_simulation_failed`, a
    rejection not making its URL active, switching on `idx !== start`, a slack of 0), plus the old
    `idx !== current` switch, no return to the first URL, a return on every call after the
    interval, a deadline without the bid read, and no trace.
- **Testnet** (2026-10-16, with the review fixes, before their commit, fresh friendbot accounts):
  `RPC_URLS=http://127.0.0.1:9,https://soroban-testnet.stellar.org EXPECT_FAILOVER=1 npx tsx
  scripts/verify-smoke.ts` passed `validPayment`, `channelRejected` and the new `failedOver`
  check: each `/verify` logged `rpc_failover` and its `verified` line named `RPC_URLS[1]`. The
  earlier run, cited at a commit that doesn't exist, predated 8b7e831 and didn't check the
  failover.

**Modified tests:** `build-verifier.test.ts`'s `setup` takes an answer that may depend on the
scheme's RPC URL and may be a promise; the old "unexpected_verify_error" test now says "on every
RPC URL", since both URLs answer it. `buildVerifier` takes a `logger` before `makeScheme`, so
`fee-agreement.test.ts` passes one. The "every endpoint fails" test in `upstream-failover.test.ts`
now also checks that the next call starts from the active endpoint, which is still the first.

**Modified tests (PR #45 review):** `upstream-failover.test.ts` builds its failovers through a
`failover(list)` helper, since `failoverUpstream` now takes an `endpoints()` function, and "needs
an endpoint" now expects the call to reject. `build-verifier.test.ts`'s first test expects one
scheme per URL, built once per bid (all URLs are built with the bid now); the failover test checks
the trace instead of which schemes were built; the slow-second-URL test takes its times from
`UPSTREAM_TIMEOUT_MS`. `fees.test.ts` tests `atCurrentBid` in place of `upstreamAtCurrentBid`.
`verify.test.ts` and `verify-route.test.ts` expect the trace argument. `verify-smoke.ts` reads the
log events from stdout and has an `EXPECT_FAILOVER` check.

## Issues Encountered

- **A stale `signer-pool` build in the main checkout** made typecheck and 6 test files fail
  (`FEE_STATS_MIN_STROOPS` missing). `pnpm install` and a rebuild of the workspace packages fixed
  it. Not a code problem.

## Design Decisions

### From Plan

1. **One `ExactStellarScheme` per URL, no upstream change** (okarcz, 2026-10-14). The other option,
   an upstream change that accepts an `rpc.Server`, would mean changing `@x402/stellar`.

### Emerged

2. **One failover across bids, with one scheme per URL per bid.** The active endpoint survives a
   new fee-stats bid. Amended by decision 8: the bid is no longer read inside each URL's scheme.
3. **A rejection is never failed over.** Only a throw, a timeout and `unexpected_verify_error`
   say nothing about the payment. A lagging RPC can make a valid payment fail simulation, and the
   verdict stands. The reason is cost and one stable answer per payload (Adam, PR #45 review):
   `/verify` is read-only and `/settle` checks again, so "verdict shopping" gains a client nothing.
4. **Upstream's deadline is 10 s per URL, plus the bid read, plus 1 s** (21 s with two URLs and a
   fixed bid, 41 s with fee-stats bids; `upstreamDeadlineMs`). The single 10 s deadline from 0018
   decision 18 would have cut off the second attempt; the 1 s lets the last URL's own deadline
   fire first. The fee-stats read, now before the URLs (decision 8), is bounded by `FallbackRpc`
   at 10 s per URL. It is upstream's deadline, not `/verify`'s whole time: the AD-22 ledger read
   after it can add `FallbackRpc`'s 10 s per URL (PR #45 review, C6).
5. **Endpoints are named `RPC_URLS[i]`, not by URL**, because an RPC URL can carry an API key
   (0018 decision 22). `main.ts` logs each switch as `rpc_failover` with these names (okarcz,
   2026-10-15, after the code review).
6. **The Horizon read stays as it is.** Upstream reads the ledger close time from Horizon, with no
   URL of ours to fail over to. It falls back to its default on an error, but a Horizon that
   hangs takes every URL past its 10 s, and `/verify` then answers 500 after 10 s per URL.
   Recorded in AD-3; fixing it needs an upstream change.
7. **Built on develop, not on 0009; the deadline travels with the upstream.** 0009 (PR #41) renames
   `buildVerifier` to `buildChecks`, which builds the `VerifierDeps` for both `createVerifier` and
   `createChecker`. Moving only the upstream would leave `/settle` on the default 10 s deadline,
   which cuts off the second URL (Adam, C1). So `buildUpstream` returns `{ upstream,
   upstreamTimeoutMs }`, and the rebase spreads that one call into `buildChecks`. Whichever of
   #41 and #45 merges second adds a `/settle` test with a hung first URL.
8. **The bid is read once per call, before any URL's deadline starts** (Adam, C2). It used to be
   read inside each URL's 10 s, through `FallbackRpc`, which keeps its own active URL: while
   `FallbackRpc` sat on a hung URL that wasn't ours, the healthy URL timed out a few ms after
   `FallbackRpc` moved on, and the call ended in a 500 after about 20 s. `failoverUpstream` now
   takes an `endpoints()` function, which `main.ts` builds with `atCurrentBid`.
9. **Calls go back to `RPC_URLS[0]` after 60 s, and `verified` names the URL** (Adam, C3; the
   return was his option, taken here). One failure of the first URL used to leave `/verify` on the
   fallback until the fallback failed. A fallback that lags more than 2 ledgers answers valid
   payments with `…_expiration_too_far` or `…_simulation_failed`, which are verdicts, so the outage
   became silent `isValid: false` answers. One call per 60 s tries the first URL first again; if
   it fails, the interval starts over, so a down first URL costs one call 10 s a minute. `rpc` in
   the `verified` log ties such rejections to their URL. A `VerifyTrace` out-parameter carries it,
   so `Verify`'s answer and `VerifyResponse` stay as they are.
10. **A late answer never switches back** (Adam, C5). A call that began on the old URL before
    another call switched only moves the active URL if it is still the one it started with, so a
    brownout doesn't flap traffic back to the degraded URL or log a switch for a URL that never
    failed. `FallbackRpc.call` has the same pattern (future work).

## Future Work

- **`FallbackRpc.call` switches back on a late answer** too (Adam, PR #45 review, C5): apply the
  same guard in `packages/signer-pool/src/fallback-rpc.ts`. To spawn as a backlog task on develop.
- **A `/settle` test with a hung first RPC URL**, by whichever of #41 and #45 merges second
  (decision 7).
