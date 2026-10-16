---
id: "0045"
title: "Fail over upstream verify across RPC_URLS before pubnet"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004", "0011"]
related_tasks: ["0018", "0009", "0049", "0023", "0027"]
tags: [facilitator, exact, payments, priority-medium, effort-small]
links:
  - ../../../../docs/architecture/m1-spine.md
  - ../../../../docs/threat-model.md
  - notes/S-pr45-reviews.md
history:
  - date: "2026-10-14"
    status: backlog
    who: okarcz
    note: "Spawned from 0018 (Adam's PR #33 review): upstream verify reads only the first RPC URL."
  - date: "2026-10-14"
    status: active
    who: okarcz
    note: "Work started while 0009 (PR #41) is in review."
  - date: "2026-10-16"
    status: active
    who: okarcz
    note: "Converted to a directory; PR #45 second review: payload-free probe, switch counter, undici timeouts, RPC_URLS cap."
---

# Fail over upstream verify across `RPC_URLS` before pubnet

## Summary

Upstream `ExactStellarScheme` takes one `rpcConfig.url`, so `/verify` used only the first
`RPC_URLS` entry and answered 500 while it was down, although `FallbackRpc` (the pool and our
ledger reads) had a working fallback. `/verify` now fails over too, and returns to the first URL
once a probe finds it healthy.

## Context

- 0018 built upstream with `rpcUrls[0]` and answered its `unexpected_verify_error`, and any call
  past a 10 s deadline, with a 500.
- Upstream also reads Horizon for the ledger close time, with no failover and no timeout.
- The review history (two rounds, C1–C6 and the second's points) is in
  [notes/S-pr45-reviews.md](notes/S-pr45-reviews.md).

## Acceptance Criteria

- [x] Given `RPC_URLS` with a down first URL and a working second, when `/verify` is called, then it
      answers from the second URL, not with a 500 (also with the real upstream:
      `fee-agreement.test.ts`)
- [x] The choice is recorded in spine AD-3

## Implementation Notes

- **`settlement/upstream-failover.ts`**: `failoverUpstream(endpoints, opts)`, with its own active
  endpoint, separate from `FallbackRpc`'s:
  - `endpoints()` is read once per call, before any endpoint's timer starts (decision 8);
  - the call starts at the active endpoint and goes on to the next when it throws, answers
    `unexpected_verify_error` or takes longer than `timeoutMs` (10 s);
  - the first endpoint with any other answer, a rejection included, becomes active, if the switch
    counter hasn't moved since the call began (decision 12);
  - while off the first endpoint, a call that finds a probe due starts one beside itself
    (decision 11);
  - hooks (`onSwitch`, `onFailback`, `onProbeFailed`, `onExhausted`) run guarded, so a throwing
    logger can't discard an answer;
  - if every endpoint fails, the first failure is the result, so `createVerifier` answers 500.
- **`main.ts`**: `buildUpstream(config, fees, logger, facilitator, seams?)` returns `{ upstream,
  upstreamTimeoutMs }` (decision 7): one scheme per URL per bid, one `rpc.Server` per URL for the
  probe, the logs of decision 15, and the deadline from `upstreamDeadlineMs(urls,
  fees.feeStats)`. `buildVerifier` builds the facilitator signer once. `main()` sets undici's
  global timeouts (decision 13), passes `UPSTREAM_TIMEOUT_MS` to `FallbackRpc`, and takes a log
  sink (`MainOptions.write`) for the smoke scripts.
- **`fees.ts`**: `atCurrentBid(inclusionFee, build)`; `FeeSettings.feeStats` says whether the bid
  is read from fee stats.
- **`verify.ts`**: `withTimeout(promise, ms, what)` names the call in its message, so a URL's 10 s
  (`RPC_URLS[0]: upstream verify …`) and the overall deadline (`upstream verify (every RPC URL)
  …`) read differently. `UpstreamVerifier.verify` and `Verify` take an optional `VerifyTrace`.
- **`config.ts`**: `RPC_URLS` lists at most `MAX_RPC_URLS` (3) URLs (decision 14).
- **`http/app.ts`**: the `verified` log carries `rpc`, the `RPC_URLS[i]` that answered.
- **Spine AD-3** and **`docs/threat-model.md`**: the probe, the logs, the deadline, the undici
  timeouts, false accepts and steering, and the Horizon limit.
- **Tests**: facilitator 103 → 113 → 125 (first review) → 142 (second review):
  `upstream-failover.test.ts` 14 → 25, `build-verifier.test.ts` 12 → 16, `fee-agreement.test.ts`
  4 → 5, `config.test.ts` 11 → 12 (the cap), and `main.test.ts`'s secret check now uses two keyed
  URLs.

**Modified tests:** listed per round in [the note](notes/S-pr45-reviews.md#modified-tests).

## Issues Encountered

- **A stale `signer-pool` build in the main checkout** made typecheck and 6 test files fail
  (`FEE_STATS_MIN_STROOPS` missing). `pnpm install` and a rebuild fixed it.
- **The 60 s retry of decision 9 trusted client payloads** as a health check (second review); it
  is replaced by the probe.

## Design Decisions

### From Plan

1. **One `ExactStellarScheme` per URL, no upstream change** (okarcz, 2026-10-14).

### Emerged

2. **One failover across bids, with one scheme per URL per bid**: the active endpoint survives a
   new bid (tested since the second review). Amended by decision 8.
3. **A rejection is never failed over.** Only a throw, a timeout and `unexpected_verify_error`
   say nothing about the payment. The reason is cost and one stable answer per payload: `/verify`
   is read-only and `/settle` checks again. This holds for a client's own call; steering
   everyone's calls is decision 11's threat.
4. **Upstream's deadline is 10 s per URL, plus the bid read, plus 1 s** (21 / 41 / 61 s;
   `upstreamDeadlineMs`). It isn't `/verify`'s whole time: the AD-22 ledger read comes after it.
   The mode comes from `FeeSettings`, not `config` (second review).
5. **Endpoints are named `RPC_URLS[i]`, not by URL**, because an RPC URL can carry an API key
   (0018 decision 22). Whether ADR 0011 and 0027 adopt it, instead of host names, is recorded in
   #41's ADR 0011 amendment.
6. **The Horizon read stays as it is.** A hung Horizon times out every URL: no switch, an
   `rpc_exhausted` line, a 500. Only an intermittently slow one logs `rpc_failover`, blaming an
   RPC URL. Fixing it needs an upstream change.
7. **The deadline travels with the upstream; #41 merges first** (okarcz, 2026-10-16).
   `buildUpstream` returns `{ upstream, upstreamTimeoutMs }`, and this PR's rebase spreads it into
   #41's `buildChecks`. Watch for the two silent breaks Adam found: `Check` has no `trace`, and
   `settle-pool.test.ts` calls `buildChecks` positionally. The rebase adds a `/settle` test with
   a hung first URL. #41 bounds the check by the settle budget and adds ADR 0011's timing row.
8. **The bid is read once per call, before any URL's deadline starts** (C2).
9. ~~Calls go back to `RPC_URLS[0]` after 60 s~~ (C3): replaced by decision 11. `rpc` in the
   `verified` log, through a `VerifyTrace` out-parameter, stays.
10. **A late answer never switches back** (C5): tightened by decision 12.
11. **The return to `RPC_URLS[0]` is a payload-free probe** (okarcz, 2026-10-16, Adam's
    proposal). While off it, a call that finds 60 s (`PRIMARY_PROBE_INTERVAL_MS`) passed since
    calls left it, or since the last probe, starts `getLatestLedger` on `RPC_URLS[0]`'s own
    `rpc.Server` and on the active URL's, without waiting. Calls return only if it answers and
    trails by at most 2 ledgers (`FAILBACK_MAX_LAG_LEDGERS`, the C3 lag guard: past it, a valid
    payment can fail `…_expiration_too_far`). One probe at a time; a fallback → fallback switch
    keeps the schedule; no timer, so nothing keeps the process alive.
12. **A switch counter guards every switch** (second review, :69): a call or a probe switches only
    if no switch happened since it began, which also closes A → B → A.
13. **undici's global header and body timeouts are 10 s** (second review, :41). stellar-sdk 16
    uses the global `fetch` (its `feaxios` client); a probe on Node 22.16 and 24.10 showed a
    stalled server cut off at the dispatcher's timeout. Abandoned upstream calls now end within
    10 s instead of 300 s.
14. **`RPC_URLS` lists at most 3 URLs** (second review, main.ts:58): each URL adds 10 s (20 s with
    fee-stats) to upstream's worst case, which `/settle`'s budget must hold.
15. **Logs carry `component: "verify"`, the network and a URL-free `reason`** (second review,
    main.ts:100): `rpc_failover` (warn), `rpc_failback` (info), `rpc_probe_failed` (warn) and
    `rpc_exhausted` (warn, every URL tried). The reason is `timeout`, `unexpected_verify_error`
    or `error:<name>`, never a message, which can carry a URL.

## Future Work

- **0049**: `FallbackRpc.call` switches back on a late answer, never returns to its first URL
  (so a lagging one serves the AD-22 read), names endpoints by full URL and logs no switches
  (Adam, both reviews).
- **0027**: an alarm or a `rpc_failovers_total{from,to}` counter, so the lag risk can be alarmed
  on (recorded in 0027 by #41).
- **The rebase onto #41** (decision 7), with a `/settle` test with a hung first URL.
- **A testnet smoke run on the pushed head**, also with a hung first URL.
