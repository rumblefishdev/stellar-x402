---
title: "PR #45 reviews: what Adam found and what changed"
type: synthesis
status: developing
spawns: []
tags: [review, facilitator, exact]
links:
  - ../README.md
history:
  - date: 2026-10-16
    status: developing
    who: okarcz
    note: "Moved out of the task README (over 150 lines), with the second review added."
---

# PR #45 reviews

## First review (Adam, 2026-10-15, at 791afd1; C1–C6, all fixed in aac6546, 892910c, b474e8a)

- **C1:** the deadline sat outside the upstream block that moves to #41's `buildChecks`.
  `buildUpstream` returns both (decision 7).
- **C2:** a healthy URL timed out while `FallbackRpc` served the bid read from a hung URL. The bid
  is read before the loop (decision 8).
- **C3:** the failover never came back to `RPC_URLS[0]`, so a lagging fallback answered silently.
  `rpc` in the `verified` log, a 60 s return and the lag risk in AD-3 (decision 9, since replaced
  by decision 11).
- **C4:** missing tests, added below.
- **C5:** a late answer on the old URL switched back (decision 10, since tightened by
  decision 12).
- **C6:** doc fixes: AD-3's deadline wording, the separate active URL, the Horizon note, the
  `upstreamTimeoutMs` docstring, a test comment, and the smoke run.
- Tests added: `upstream-failover.test.ts` 8 → 14 (9 `it` plus rows of 2 and 3),
  `build-verifier.test.ts` 5 → 12, `fees.test.ts` (`atCurrentBid`), `verify-route.test.ts` +1.
  Facilitator 113 → 125.
- Mutants caught (1–7 tests each): failover on `…_simulation_failed`, a rejection not making its
  URL active, switching on `idx !== start`, a slack of 0, the old `idx !== current` switch, no
  return to the first URL, a return on every call after the interval, a deadline without the bid
  read, no trace.

## Second review (Adam, 2026-10-16, at b474e8a; changes requested)

C1–C4 and C6 held; the new 60 s retry was where the problems were.

- **:57, :62, :71 (must fix):** the retry used a client's payload as a health check. Upstream
  refuses a wrong amount, recipient, asset or operation before any RPC call, so a dead
  `RPC_URLS[0]` "answered" in 1 ms and became active; a quota-exhausting client could also keep
  everyone on a fallback (steering). With 3 URLs the retry walked 0 → 1 → active through known-bad
  URLs, and a fallback → fallback switch restarted the 60 s. **Fixed:** the payload-free probe
  (decision 11), chosen by okarcz over the smaller `[0, active]` order.
- **:69 (should fix):** no test covered `current === active` (the mutant survived), and an
  A → B → A sequence let a late answer switch back. **Fixed:** a switch counter (decision 12),
  tests for three concurrent calls and for A → B → A.
- **:72 (nit):** a throwing `onSwitch` discarded a valid answer. **Fixed:** hooks run guarded,
  after the answer is in hand.
- **:41 (should fix):** abandoned upstream calls held sockets for undici's 300 s default, N per
  request when every URL hangs. **Fixed:** `setGlobalDispatcher` with 10 s header and body
  timeouts in `main()` (decision 13), and `RPC_URLS` capped at 3 (decision 14).
- **main.ts:58 (cross-PR):** the trial merge with #41 showed `/settle`'s check isn't bounded by
  its budget (61 s with 2 URLs and fee-stats). **Split:** #41 merges first and bounds the check by
  the budget, with ADR 0011's timing row; here, the cap (decision 14). The two silent merge breaks
  (no `trace` in `Check`, `settle-pool.test.ts` calling `buildChecks` positionally) are for the
  rebase, which is this PR's (#41 first).
- **main.ts:102 (should fix):** fee-stats mode came from `config` while the bid came from `fees`;
  the ×2 relied on `FallbackRpc`'s default timeout; `primaryRetryMs` reached production only
  through its default. **Fixed:** `FeeSettings.feeStats`, `FallbackRpc.fromUrls(…, { timeoutMs:
  UPSTREAM_TIMEOUT_MS })`, `PRIMARY_PROBE_INTERVAL_MS` passed and asserted.
- **main.ts:100 (should fix):** `rpc_failover` had no reason, network or component; the return
  read like an outage; a failed retry and an all-URLs failure were silent; the per-URL and overall
  timeouts had the same message. **Fixed:** decision 15. The metric and the naming question
  (ADR 0011 says "by host", this PR uses `RPC_URLS[i]`) go to #41's ADR 0011 amendment and 0027.
- **main.ts:124 (nit):** the facilitator signer was built twice. **Fixed:** built once in
  `buildVerifier` and passed to `buildUpstream`.
- **Spine :96 (must fix):** a hung Horizon logs no `rpc_failover`. **Fixed** in AD-3 and the PR
  body: only an intermittently slow Horizon does.
- **Spine :92 (should fix):** a lagging RPC can also accept what the first would refuse.
  **Fixed:** AD-3 and `docs/threat-model.md` (with the steering case).
- **build-verifier.test.ts:236 (test gaps):** all added: the hang test on a fixed bid (the slack
  only matters at 21 s), the real upstream with a refused first URL in `fee-agreement.test.ts`,
  decision 2 across a bid change, payload forwarding, and the secret check with two keyed URLs
  that both fail (`console_error`, `rpc_exhausted`, `http_error`, `rpc_failover`).
- **verify-smoke.ts:110 (nit):** the stdout patch dropped split lines. **Fixed:** `main()` takes a
  log sink; the script prints log lines to stderr and only the result to stdout. The smoke run is
  to be repeated on the pushed head.
- **Task nits:** this note (the README was 197 lines), the counts above, 0049 cited,
  `related_tasks` extended.
- **Mutants** run on the new code (12): 10 caught (1–3 tests each), among them the `current ===
  active` guard, a probe interval of `Infinity`, `nextProbeAt` reset on every switch, no lag check,
  an unguarded `onSwitch`, a slack of 0 and the fee-stats mode from `config`; 2 equivalent (the
  defaults of `maxLagLedgers` and of `FallbackRpc`'s timeout equal the values passed). A probe
  answer applied after another switch survived until its test was added.

## Third review (Adam, 2026-10-16, at cf6ee6a; changes requested)

11 of 15 points resolved; A7, A9 and A12 deferred as agreed.

- **A1 (blocker):** a call that failed on the active fallback still wrapped to `RPC_URLS[0]` and
  made it active on any answer, a pre-RPC `…_wrong_amount` included, so a client's payload could
  bring back a dead primary with no probe and no lag guard. **Fixed** (decision 16): from a call,
  index 0 is never switched to; the call returns its answer and the probe is due at once. Tests:
  "wraps around from the active endpoint, without making the first one active" (was "wraps
  around…", which asserted the bug) and the dead-primary-wrong-amount case. The A → B → A
  switch-counter test now returns to A through the probe.
- **A13:** the decision-2 test didn't pin decision 2 (`rpc-a` is always down, so a reset to
  `[0]` on a new bid ended on `[1]` too). **Fixed:** it checks the URLs called across the bid
  change and that exactly one `rpc_failover` is logged; the "reset `current` on a bid change"
  mutant now fails it.
- **A14 (nit):** the smoke run was before the commit, with no SHA. To be run on the pushed head;
  see Testnet.
- **Mutants:** of the five survivors, three are killed by new tests: the probe's `withTimeout`
  (a hung `latestLedger(0)` counts as down and the next probe still runs), the "active can't read
  its ledger → return" branch, and the bid-change reset (A13). `setGlobalDispatcher` was checked
  by hand by Adam; the real `rpcLatestLedger` still runs in no test.

## Testnet

- 2026-10-16, with the first review's fixes, before their commit, fresh friendbot accounts:
  `RPC_URLS=http://127.0.0.1:9,https://soroban-testnet.stellar.org EXPECT_FAILOVER=1 npx tsx
  scripts/verify-smoke.ts` passed `validPayment`, `channelRejected` and `failedOver`. It exercised
  only a refused connection, not a hang or the return.
- 2026-10-16, with the second review's fixes, uncommitted on top of b474e8a, fresh friendbot
  accounts: the same run with `RPC_URLS=http://127.0.0.1:9,…` (refused) and with a local server
  that accepts and never answers (hung) as `RPC_URLS[0]`. Both passed `validPayment`,
  `channelRejected` and `failedOver`, answered by `RPC_URLS[1]`; the hung run logged
  `rpc_failover` with `reason: "timeout"`. The hung run first failed: `main()`'s 10 s undici
  bound also cut off the script's own `/verify` request, so the script now has its own dispatcher.
  The return to `RPC_URLS[0]` isn't exercised on testnet (it needs 60 s and a URL that recovers).
- 2026-10-16, repeated on the code of the second round's commit before it was committed, with the
  fixed `x402-verify-client` / `x402-verify-seller` keys and the script's own dispatcher: plain
  `RPC_URLS` (answered by `RPC_URLS[0]`, no switch), a refused first URL (`rpc_failover`,
  `reason: "unexpected_verify_error"`) and a hung first URL (`reason: "timeout"`). All three
  passed `validPayment` and `channelRejected`; the two failover runs also `failedOver`, answered by
  `RPC_URLS[1]`.

## Modified tests

- **Before review:** `build-verifier.test.ts`'s `setup` takes an answer that may depend on the
  scheme's RPC URL and may be a promise; the old "unexpected_verify_error" test says "on every RPC
  URL", since both URLs answer it. `buildVerifier` takes a `logger` before `makeScheme`, so
  `fee-agreement.test.ts` passes one. The "every endpoint fails" test in
  `upstream-failover.test.ts` also checks that the next call starts from the active endpoint.
- **First review:** `upstream-failover.test.ts` builds its failovers through a `failover(list)`
  helper, since `failoverUpstream` takes an `endpoints()` function, and "needs an endpoint" expects
  the call to reject. `build-verifier.test.ts`'s first test expects one scheme per URL, built once
  per bid; the failover test checks the trace; the slow-second-URL test takes its times from
  `UPSTREAM_TIMEOUT_MS`. `fees.test.ts` tests `atCurrentBid` in place of `upstreamAtCurrentBid`.
  `verify.test.ts` and `verify-route.test.ts` expect the trace argument. `verify-smoke.ts` gained
  the `EXPECT_FAILOVER` check.
- **Second review:** `upstream-failover.test.ts`'s `onSwitch` assertions take the
  failure as a third argument, and the 60 s retry test is replaced by the probe tests.
  `build-verifier.test.ts`'s `setup` takes an options object (`feeStatsMs`, `fees`, `config`,
  `latestLedger`) and passes `{ makeScheme, latestLedger }` seams; the logger has `info`; the
  "every URL hangs" test runs on a fixed bid and expects the per-URL message; `buildUpstream` takes
  the signer. `fee-agreement.test.ts`'s logger has `info`. `main.test.ts`'s console test makes two
  requests over two keyed URLs. `verify-smoke.ts` reads the events from `main()`'s log sink.
- **Third review:** "wraps around from the active endpoint" now expects no switch to the first
  endpoint; the A → B → A test returns to A through a probe (`latestLedger`, `now`).
  `build-verifier.test.ts`'s decision-2 test records the URLs called and counts `rpc_failover`.
