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
  - date: "2026-10-16"
    status: active
    who: okarcz
    note: "PR #45 third review: a call that wraps around to RPC_URLS[0] doesn't switch to it."
  - date: "2026-10-21"
    status: active
    who: okarcz
    note: "Karol's review; rebased onto #41: /settle's checks fail over too, with hung-URL /settle tests."
  - date: "2026-10-21"
    status: active
    who: okarcz
    note: >
      Rebased onto develop after #41 merged. Testnet showed a hung RPC_URLS[0] waited out by
      upstream and FallbackRpc each, past /settle's budget: one active URL, owned by FallbackRpc,
      now serves both (decisions 21-25). Failover logs name RPC_URLS[i]#<fingerprint>.
---

# Fail over upstream verify across `RPC_URLS` before pubnet

## Summary

Upstream `ExactStellarScheme` takes one `rpcConfig.url`, so `/verify` used only the first
`RPC_URLS` entry and answered 500 while it was down, although `FallbackRpc` (the pool and our
ledger reads) had a working fallback. `/verify` now fails over too, and returns to the first URL
once a probe finds it healthy. Since decision 21 both use one active URL, owned by `FallbackRpc`,
so one outage moves `/verify`, `/settle`'s checks and the pool once.

## Context

- 0018 built upstream with `rpcUrls[0]` and answered its `unexpected_verify_error`, and any call
  past a 10 s deadline, with a 500.
- Upstream also reads Horizon for the ledger close time, with no failover and no timeout.
- A local gate run on 2026-10-22 (0028 harness, PR #51 build, default single RPC URL) passed 14 of
  18: from 09:33 to 09:37 UTC `soroban-testnet.stellar.org` gave no answer within 10 s, so
  `/verify` and the checks inside `/settle` answered 500 three times. With one URL, failover has
  nowhere to go, so `deploy/testnet.env.example` lists more than one provider (decided
  2026-10-22). Public testnet RPCs on the Stellar providers page
  (developers.stellar.org/docs/data/apis/rpc/providers): SDF and Gateway answered
  `getLatestLedger` that day; Nodies' listed URL answered 404 on `/`.
- The review history (two rounds, C1–C6 and the second's points) is in
  [notes/S-pr45-reviews.md](notes/S-pr45-reviews.md).

## Acceptance Criteria

- [x] Given `RPC_URLS` with a down first URL and a working second, when `/verify` is called, then it
      answers from the second URL, not with a 500 (also with the real upstream:
      `fee-agreement.test.ts`)
- [x] The choice is recorded in spine AD-3
- [x] Given `deploy/testnet.env.example`, when it is read, then `RPC_URLS` names at least two
      public testnet providers (SDF, then Gateway, as in decision 25)

## Implementation Notes

- **`settlement/upstream-failover.ts`** (until decision 21 moved the state and the probe into
  `FallbackRpc`, below): `failoverUpstream(endpoints, opts)`, with its own active endpoint:
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
- **Tests**: facilitator 103 → 113 → 125 (first review) → 142 (second review) → 145 (third review):
  `upstream-failover.test.ts` 14 → 25 → 28, `build-verifier.test.ts` 12 → 16, `fee-agreement.test.ts`
  4 → 5, `config.test.ts` 11 → 12 (the cap), and `main.test.ts`'s secret check now uses two keyed
  URLs.

- **After the rebase onto #41**: `buildChecks(config, rpc, fees, logger, seams?)` spreads
  `buildUpstream`, so `/settle`'s checks fail over too; `buildVerifier` is `createVerifier` over
  it, and `compose()` passes its `seams`. `Check` takes the trace. `UpstreamSeams.timeoutMs`
  (decision 19) and `upstreamDeadlineMs`'s per-URL `timeoutMs`. `settle-smoke.ts` has its own
  dispatcher and an `EXPECT_FAILOVER` check (decision 20).
- **Tests after Karol's review and the rebases**: 240 on develop (0022's tests included), 366 on
  #41 (#41's tests included). This round adds `upstream-failover.test.ts` +1 (the probe gap),
  `settle-pool.test.ts` +2 (a hung first URL) and `build-verifier.test.ts` +1 (the test timeout).

- **After the rebase onto develop and the shared active URL** (2026-10-21, decisions 21–25):
  - `FallbackRpc` (signer-pool) owns the active URL: `begin()` gives a call's starting index and
    token, `markFailed(index, token, error, by)` moves every caller on, a switch counter guards
    its own calls too (a late answer can't switch back), and with `failback` it runs the probe
    back to `RPC_URLS[0]` (decision 11's rules, moved);
  - `failoverUpstream` keeps no state: it starts each call at `begin()`'s index, after reading
    `endpoints()`, and reports a throw or a timeout (decision 22);
  - `main.ts`: `buildRpc(config, logger, makeRpc?, timeoutMs?)` builds the one `FallbackRpc` with
    endpoints named `RPC_URLS[i]#<fingerprint>` and logs its switches, failbacks and probe
    failures (decision 23); `buildUpstream` takes it as `active`; `compose()` serves a test's
    `rpc` on every URL;
  - `settle-smoke.ts` passes `INCLUSION_FEE_STROOPS` on, for the hung-URL run in both bid modes.
- **Tests on develop**: facilitator 302 → 293 (+71 PostgreSQL, skipped without a database): the
  probe tests moved to signer-pool, `upstream-failover.test.ts` 28 → 18, `settle-pool.test.ts`
  +2 (`RPC_URLS[0]` hung for every client, one per bid mode). signer-pool 111 → 124 (the shared
  state, the switch counter and the probe). Each new rule has a test that fails on its mutant.

**Modified tests:** listed per round in [the note](notes/S-pr45-reviews.md#modified-tests).

## Issues Encountered

- **A stale `signer-pool` build in the main checkout** made typecheck and 6 test files fail
  (`FEE_STATS_MIN_STROOPS` missing). `pnpm install` and a rebuild fixed it.
- **The 60 s retry of decision 9 trusted client payloads** as a health check (second review); it
  is replaced by the probe.
- **A hung `RPC_URLS[0]` timed out the first `/settle` on testnet** (2026-10-21), although every
  unit test passed: each test faked one client, so none saw upstream and `FallbackRpc` each wait
  out the same URL. Fixed by decision 21, with `settle-pool.test.ts` tests that hang the URL for
  every client.
- **soroban-testnet stalls** past 10 s now and then (decision 25), which made hung runs flaky.

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
5. **Endpoints are named `RPC_URLS[i]`, not by URL** (`RPC_URLS[i]#<fingerprint>` since decision
   24), because an RPC URL can carry an API key
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
11. **The return to `RPC_URLS[0]` is a payload-free probe** (okarcz, 2026-10-16, Adam's proposal;
    `FallbackRpc`'s since decision 21, which reads both ledgers with its own clients). While off it,
    a call that finds 60 s (`PRIMARY_PROBE_INTERVAL_MS`) passed since calls left it, or since the
    last probe, starts `getLatestLedger` on `RPC_URLS[0]`'s own `rpc.Server` and on the active
    URL's, without waiting. Calls return only if it answers and trails by at most 2 ledgers
    (`FAILBACK_MAX_LAG_LEDGERS`, the C3 lag guard: past it, a valid payment can fail
    `…_expiration_too_far`). One probe at a time; a fallback → fallback switch keeps the schedule;
    no timer, so nothing keeps the process alive.
12. **A switch counter guards every switch** (second review, :69): a call or a probe switches only
    if no switch happened since it began, which also closes A → B → A.
13. **undici's global header and body timeouts are 10 s** (second review, :41). stellar-sdk 16
    uses the global `fetch` (its `feaxios` client); a probe on Node 22.16 and 24.10 showed a
    stalled server cut off at the dispatcher's timeout. Abandoned upstream calls now end within
    10 s instead of 300 s.
14. **`RPC_URLS` lists at most 3 URLs** (second review, main.ts:58): each URL adds 10 s (20 s with
    fee-stats) to upstream's worst case, which `/settle`'s budget must hold.
15. **Logs carry `component: "verify"`, the network and a URL-free `reason`** (amended by decision
    23: switches, failbacks and probes are the shared client's, `component: "rpc"`) (second review,
    main.ts:100): `rpc_failover` (warn), `rpc_failback` (info), `rpc_probe_failed` (warn) and
    `rpc_exhausted` (warn, every URL tried). The reason is `timeout`, `unexpected_verify_error` or
    `error:<name>`, never a message, which can carry a URL.
16. **A call never switches to `RPC_URLS[0]`** (third review, A1; since decision 21 a verify call
    never moves the state on an answer at all, and the wrap-around probe is gone): a call whose
    active fallback fails and that wraps around to `RPC_URLS[0]` returns its answer without
    switching, and makes a probe due at once. Otherwise a payload upstream answers before any RPC
    call (a wrong amount) would bring back a dead primary, which decision 11 rules out. Only the
    probe returns to it.
17. **The return to `RPC_URLS[0]` stays; a wrap-around probe waits 5 s after the last one**
    (the 5 s gap went with the wrap-around probe in decision 23)
    (okarcz, 2026-10-20, Karol's review). Karol asked whether failover that stays on the new URL
    would do. It would drop about 40% of the code, but leave calls on a fallback until a restart,
    where a lagging one fails valid payments. Of his two edge cases, a double outage made every
    wrapping call start a probe and log `rpc_probe_failed`; `minProbeGapMs` (5 s) now spaces them.
    The other, a return with no lag check when the active URL can't read its own ledger, is
    intended (decision 11's "no reason to stay on it") and now documented.
18. **The rebase onto #41 merges both shapes** (2026-10-21). `buildChecks` keeps #41's name and
    `VerifierDeps` return, and spreads `buildUpstream` (decision 7); it and `buildVerifier` take a
    `logger` and `seams`, not a positional `makeScheme`. Adam's two silent breaks are fixed:
    `Check` takes the trace, and `settle-pool.test.ts` passes `seams`. `main()` keeps #41's
    `compose()` and PostgreSQL stores, with this PR's undici timeouts, `opts.write` and
    `FallbackRpc`'s 10 s; its logger takes both `opts.write` and #41's `RPC_URLS` redaction.
19. **`/settle` is tested with a hung `RPC_URLS[0]` both ways** (okarcz, 2026-10-21): it settles
    through `RPC_URLS[1]` and logs `rpc_failover`, and a budget shorter than the failover answers
    `…_timeout` with nothing sent, as 41 s of fee-stats failover would against the 30 s default
    (ADR 0011's table). `UpstreamSeams.timeoutMs` makes the hang take milliseconds, not 10 s.
    On testnet the first `/settle` timed out even with a fixed bid: decision 21.
20. **`settle-smoke.ts` sends every request through its own `Agent`** (okarcz, 2026-10-21,
    Karol's review): `/settle`, `/verify` and friendbot, with a 120 s header timeout, above
    `/settle`'s 90 s answer. It passes `RPC_URLS` on; `EXPECT_FAILOVER=1` checks that the first
    `/settle` failed over from `RPC_URLS[0]` to `RPC_URLS[1]` and, since decision 21, settled.
21. **One active URL for upstream verify and the pool, owned by `FallbackRpc`** (okarcz,
    2026-10-21). The testnet smoke run with a hung `RPC_URLS[0]` timed out the first `/settle`:
    upstream waited 10 s on it, then the AD-22 ledger read waited `FallbackRpc`'s own 10 s on it,
    and with fee-stats the bid read a third time (trace: 27.8 s fixed, 30 s and `pending` with
    fee-stats). Upstream takes only a URL (`getRpcClient` builds an `rpc.Server` per call), so it
    can't use our client; it takes the URL to start on from `FallbackRpc.begin()` and reports a
    failure with `markFailed`. Considered: a separate `EndpointHealth` object both consult (the
    same logic, plus its own probe clients, lifecycle and API in both packages) and syncing two
    states through `onSwitch` (smaller, but they drift). Calls already waiting on a hung URL still
    wait their own 10 s. This pulls 0049's return to the first URL and its late-answer fix into
    signer-pool here.
22. **Only a throw or a timeout moves the shared URL** (okarcz, 2026-10-21). A hang, the costly
    case, shows as a timeout. `unexpected_verify_error` still makes that call try the next URL,
    but moves nothing: it is also what upstream answers when one odd payload makes it fail, and
    that must not move the pool's sends. A refused URL, which upstream answers the same way, fails
    the shared client's own next read at once and moves it there.
23. **The shared client logs every switch once** (2026-10-21): `rpc_failover` with
    `component: "rpc"`, the network, `by` (the method, such as `getFeeStats`, or `verify`), `from`,
    `to` and a URL-free `reason`; `rpc_failback` and `rpc_probe_failed` likewise. `rpc_exhausted`
    stays upstream's (`component: "verify"`). A call's answer never moves the state, so the
    wrap-around probe and its 5 s gap (decisions 16, 17) are gone; a dead fallback that the first
    URL answers for moves calls back on the shared client's own read.
24. **Failover logs name `RPC_URLS[i]#<fingerprint>`** (2026-10-21, 0009 decision 47), so a line
    written before `RPC_URLS` changed can't be read as today's entry; the smoke scripts match the
    names by prefix.
25. **The hung-URL smoke runs use Gateway's public testnet RPC as `RPC_URLS[1]`** (okarcz,
    2026-10-21). `soroban-testnet.stellar.org` gave no answer within 10 s to 1 of 40 plain
    `getLatestLedger` calls and once took 4.8 s, which failed about one hung run in three, old code
    and new alike. `https://soroban-rpc.testnet.stellar.gateway.fm` (keyless, listed on
    developers.stellar.org) answered 20 of 20 within 202 ms; Nodies' public URL answered no JSON.

## Future Work

- **0049**: what's left after decision 21: `FallbackRpc.fromUrls` still names endpoints by full
  URL (`main()` no longer uses it), and a frozen endpoint (its ledger stuck) isn't a failure yet.
  The late-answer fix, the return to the first URL and the switch logs are done here.
- **0027**: an alarm or a `rpc_failovers_total{from,to}` counter, so the lag risk can be alarmed
  on (recorded in 0027 by #41).
- **Calls already waiting on a hung URL** still wait their own 10 s when another caller moves the
  state (decision 21); a burst of first calls pays once each. Not planned.
