---
id: "0049"
title: "Fix FallbackRpc's switching: late answers, frozen endpoints, return to the first URL, URL-free logs"
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
  - date: "2026-10-16"
    status: backlog
    who: claude
    note: >
      Extended from Adam's fourth PR #41 review (wrap only transport failures) and the third
      PR #45 review (a call never switches to the first URL).
  - date: "2026-10-20"
    status: backlog
    who: karolkow
    note: >
      Extended with frozen endpoints: one that keeps answering with a ledger that no longer
      advances is never switched away from, and settlements hang in `pending`. Kept here, not in
      PR #45, so every switching rule lives in one place.
  - date: "2026-10-21"
    status: backlog
    who: claude
    note: >
      Narrowed by 0045 decision 21: PR #45 made FallbackRpc own the active URL that upstream
      verify shares, with the switch counter, the return to the first endpoint and the switch logs.
      Left here: frozen endpoints, transport-only RpcUnavailableError, fromUrls names, and the
      Attempt.sent split.
---

# Fix `FallbackRpc`'s switching: late answers, frozen endpoints, return to the first URL, URL-free logs

## Summary

`FallbackRpc.call` (`packages/signer-pool/src/fallback-rpc.ts`) moves the active endpoint
whenever the endpoint that answered isn't the current one: `if (idx !== this.current)`. A call
that began on the old endpoint, before another call switched away from it, can answer late and
switch back. During a brownout that flaps the pool's and the ledger reads' traffic back to the
degraded endpoint, and `onSwitch` reports a switch for an endpoint that never failed. Switch only
when no other call has switched since this one began.

`FallbackRpc` also never leaves an endpoint that answers but has stopped advancing, never
returns to its first endpoint, names endpoints by their full URL, and logs no switches. Fix those together, in the shape 0045 gave upstream verify's failover.

**Done in 0045 (decision 21, PR #45):** `FallbackRpc` now owns the active URL that upstream verify
shares; a switch counter guards `call()`, `sendTransaction` and the shared `markFailed`, so a late
answer can't switch back (A → B → A included); with `failback` it probes the first endpoint every
60 s and returns within 2 ledgers; `main()` builds it with `RPC_URLS[i]#<fingerprint>` names and
logs `rpc_failover`, `rpc_failback` and `rpc_probe_failed`. What's left: frozen endpoints,
transport-only `RpcUnavailableError`, `fromUrls`' names (no longer used by `main()`), and the
`Attempt.sent` split.

**Lane:** Payments

## Context

- 0045 fixed the same pattern in `failoverUpstream`, first with an index guard (decision 10). Adam
  then showed that an A → B → A sequence still lets a late answer switch back with that guard,
  so 0045 uses a switch counter captured at call start (decision 12). Use the counter here too.
- `sendTransaction` already switches only while the active endpoint is still the one it used
  (`this.current === from`), which has the same A → B → A hole.
- **A frozen endpoint is never left.** `call()` switches only on a throw or a timeout. An endpoint
  whose ledger stops advancing still answers 200, so it stays active:
  - `LedgerClock` never sees a new ledger, and `confirm()` (`submitter.ts`) waits for one with no
    deadline, so the settlement stays `pending` and its channel stays held;
  - each new settlement does the same, until the pool runs out and `/settle` refuses with
    `queue-timeout` or `no-channels`;
  - nothing names the cause: `/health` checks only liveness, and there is no ledger-age metric.

  Money stays safe. `NOT_FOUND` carries the endpoint's own `latestLedger`, so a frozen endpoint
  never makes a landed transaction look dead. A wall-clock deadline in `confirm()` would make it
  look dead, and a client that signs again then pays twice, so the fix must be in the switching.
  PR #45's probe guard (at most 2 ledgers behind) covers only the return to `RPC_URLS[0]`.
- **No return to the first endpoint** (Adam, PR #45 second review, spine :92). Upstream verify now
  returns to `RPC_URLS[0]` after a payload-free probe (0045 decision 11); `FallbackRpc` stays on
  whichever endpoint last answered. The AD-22 ledger read in `/verify` goes through it, so a
  lagging fallback reports a lower ledger, and `/verify` accepts payloads with fewer real ledgers
  left than `MIN_VALIDITY_LEDGERS`, which `/settle` then refuses.
- **Names are full URLs** (`fromUrls` uses `name: url`). An RPC URL can carry an API key, so a
  name must never reach a log. ADR 0011 (as amended by 0009) logs RPC endpoints as
  `RPC_URLS[i]#<fingerprint>` (`rpcEndpointName`), as 0045 does for upstream verify.
- **No switch logs**: `main()` passes no `onSwitch`, so a pool or ledger-read failover is
  silent, unlike upstream verify's `rpc_failover`.
- **Every all-endpoints failure becomes `RpcUnavailableError`** (Adam, PR #41 fourth review,
  fallback-rpc.ts:107). stellar-sdk throws a JSON-RPC error answer as a plain object
  (`throw response.data.error`), so a request-level error on every endpoint, such as invalid
  params on `simulateTransaction`, becomes `RpcUnavailableError("…: [object Object]")` →
  `rpc_unavailable`, with no `settlement_submit_failed` log. It used to be `unexpected` plus an
  error log.

## Implementation

- In `call()` and `sendTransaction`, capture a switch counter at call start, and switch only if
  it hasn't moved (0045 decision 12).
- Treat a frozen endpoint as failed: when the ledger sequence an endpoint reports hasn't advanced
  for `STALE_AFTER_MS` of wall-clock time, its next answer counts as a failure, and the call moves
  on with reason `stale`. Ledgers close about every 5–6 s (assumption, to confirm on testnet
  before choosing the value; 30 s is the starting point). If every endpoint is frozen, the
  `ready` field of `GET /health` (0026) is false and a log line says why. Never close a
  settlement on this signal: switching is the only change.
- Return to the first endpoint as 0045 decision 11 does: a `getLatestLedger` probe of endpoint 0
  every 60 s while off it, started beside a call, never inside one, and a return only within 2
  ledgers of the active endpoint. A call that wraps around to endpoint 0 never switches to it
  (0045 decision 16).
- Wrap only transport failures (timeouts, no response, 5xx/429) in `RpcUnavailableError`; let a
  JSON-RPC error answer through, so `/settle` logs it as before.
- `fromUrls` names endpoints with `rpcEndpointName` (`RPC_URLS[i]#<fingerprint>`), and `main()` logs switches as `rpc_failover` with
  `component: "rpc"`, the network and a URL-free reason.
- Tests: a frozen endpoint left for a live one, with a pending confirmation that then finishes;
  every endpoint frozen; the late answer, A → B → A, the probe's return and its lag guard, a log
  with no URL, and a JSON-RPC error on every endpoint that isn't `rpc_unavailable`.
- From 0009 (Adam's seventh PR #41 review, decision 58): split `Attempt.sent: "yes"` into
  accepted and refused. `/settle` now keeps a record `pending` after an unexpected error that
  follows any answered send, since `"yes"` can't tell an accepted send from a refused one; with
  the split, only an accepted one needs to.
- From 0045 (Adam's last PR #45 review), none of them blocking it:
  - The `RPC_URLS` docstring in `apps/facilitator/src/config.ts` still says the pool's reads stay
    on the URL they moved to and upstream verify fails over on its own. Since 0045 decision 21
    they share one active URL, and the pool returns to the first one too. Rewrite it to match.
  - Refuse duplicate `RPC_URLS` entries: with `a,a` failover lands on the same provider and costs
    a second 10 s.
  - `failoverUpstream` keeps going after `/settle`'s budget has answered, since `bounded()` can't
    cancel it: it tries the next URLs, reports their timeouts with `markFailed` and logs
    `rpc_exhausted` for a request already answered. Stop it once the caller gives up, for example
    with an abort signal or a deadline passed in.

## Acceptance Criteria

- [x] Given a call that began on an endpoint before another call switched away from it, when it
      answers late, then the active endpoint doesn't change and `onSwitch` isn't called (0045)
- [x] A signer-pool test covers it, and fails with the old condition (0045)
- [x] Given calls on a fallback, when a probe finds endpoint 0 answering within 2 ledgers, then
      calls return to it; a probe that fails or lags keeps them on the fallback (0045)
- [ ] Given an active endpoint whose ledger hasn't advanced for `STALE_AFTER_MS` while another
      advances, when the pool confirms a pending transaction, then calls move to the live endpoint,
      the switch is logged with reason `stale`, and the transaction ends `success`, `failed` or
      `expired` from the live endpoint's answer
- [ ] Given every endpoint frozen, then `GET /health` reports `ready` false and no settlement is
      closed because of it
- [ ] No `FallbackRpc` name or log line contains an RPC URL, and each switch is logged (done for
      `main()`'s client in 0045; `fromUrls` still names by URL)
