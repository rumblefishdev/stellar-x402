---
id: "0018"
title: "Verify exact payments"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004", "0005", "0006", "0007"]
related_tasks: ["0012", "0017", "0009", "0045"]
tags: [facilitator, exact, priority-high, effort-medium, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.3 (Payments lane)."
  - date: "2026-10-12"
    status: active
    who: okarcz
    note: >
      Work started.
---

# Verify `exact` payments

## Summary

As a resource server, I want `POST /verify` to check an `exact` payment the way the Stellar spec requires, so that I only serve resources for payments that can settle.

**Story:** [M1 Story 1.3](../../../docs/planning/m1-epics.md#story-13-verify-exact-payments) · **Lane:** Payments · **Covers:** FR1, FR5, FR7, FR8 (AD-3, AD-5, AD-10, AD-22)

## Context

- Upstream `@x402/stellar` owns verification (AD-3). Upstream only knows our signer addresses, not our channels, so the channel check is ours (ADR 0005).
- `/settle` (0009) reruns the same three checks, so build them as one reusable function.
- Related tasks: 0017, 0009.

## Implementation

- `settlement/verify.ts`: upstream `verify()`, then the channel check, then the validity check against the current ledger.
- Channel check covering transaction source, operation sources, `from` and every auth entry address, for both credential types.
- Fee config from 1.1 passed to `ExactStellarScheme` and to the pool.
- Wire `/verify` in `http/` with x402 v2 request and response types.

## Acceptance Criteria

- [x] Given a valid `exact` payload on `stellar:testnet`, when `/verify` is called, then it returns 200 with `{isValid: true, payer}`, using upstream `ExactStellarScheme.verify()`; we never re-implement upstream's signature, scope, simulation or event checks
- [x] Given a payload where a channel account appears as the transaction source, an operation source, `from`, or the address of any auth entry (`Address` or `AddressV2`), when `/verify` is called, then it returns `isValid: false` with a reason (AD-5)
- [x] Given a payload whose auth expires fewer than `minValidityLedgers` ledgers ahead, when `/verify` is called, then it returns `isValid: false` with a reason (AD-22)
- [x] Given a malformed request body, when `/verify` is called, then it returns 400, and an unexpected error returns 500
- [ ] Given the fee configuration, when the app wires `ExactStellarScheme` and the pool, then one `maxFeeStroops` and one `inclusionFeeStroops` value feed both, and the client's fee is never used (AD-10). `/verify` half done: `main()` builds one `fees` and passes it to `buildVerifier`; open until 0009 builds the pool from the same `fees.pool`

## Implementation Notes

- **`settlement/verify.ts`**: `createVerifier()` returns the `Verify` function that `/verify` uses and `/settle` (0009) will use. It runs:
  - our network check (this process serves one network);
  - upstream `ExactStellarScheme.verify()`;
  - `channelProblem()`: the transaction source, operation sources, `from` and each auth entry's address (`Address` and `AddressV2`, through upstream's `getAddressCredentials`), with muxed addresses counted as their base account;
  - `authExpiration()`: the earliest `signatureExpirationLedger`, compared with the latest ledger.
- **`settlement/fees.ts`**:
  - `feeSettings(config.fees, rpc)` gives the ceiling, the current inclusion bid and the pool options from one config. The pool and `/verify` share one bid: `INCLUSION_FEE_STROOPS`, or one fee-stats provider. `main()` builds it once; 0009 builds the pool from the same `fees.pool`.
  - `upstreamAtCurrentBid` reads that bid on every `/verify` and gives upstream twice it, `settlementInclusionFee(bid)`, the inclusion fee a fee-bumped settlement pays (decision 14).
  - Testnet measurement: the first fee-stats read took 586 ms, including opening the connection; a cached read took 0 ms. A read happens at most once per 30 s, and concurrent callers share it.
- **`http/app.ts`**: `POST /verify` checks the body with `@x402/core`'s v2 schemas (`parsePaymentRequest`, reusable by `/settle`). It answers 400 `bad_request` for a bad body, 200 with the x402 body for any outcome, and 500 when verification throws. It logs one `verified` event.
- **`main.ts`**: `buildVerifier(config, rpc, fees)` builds `ExactStellarScheme` with the facilitator key as its only signer, the first RPC URL, `MAX_FEE_STROOPS` and twice the current bid. The latest ledger comes from `FallbackRpc` over all `RPC_URLS`. `main()` also routes upstream's `console.error` through the logger (decision 22).
- **`config.ts`**: `MAX_FEE_STROOPS` and `INCLUSION_FEE_STROOPS` are capped at `Number.MAX_SAFE_INTEGER`, because both components take a `number`.
- **Tests**: facilitator 46 → 74 (`verify.test.ts` 13, `verify-route.test.ts` 10, `fees.test.ts` 5). The verifier tests build real XDR transactions against a fake upstream. Mutating the muxed normalization, the off-by-one, earliest-vs-latest, the auth check or the operation-source check each fails a test.
- **Testnet smoke** (`scripts/verify-smoke.ts`): a client signs a real `exact` XLM-SAC payment with upstream's client, and two facilitators built by `main()` verify it.
  - With `MIN_VALIDITY_LEDGERS` 4, the payment is `isValid: true` with the right payer (AC 1), and a facilitator that lists the client as a channel rejects it with `extra.reason` set.
  - With the old default 12, the valid payment was rejected: "auth expires at ledger 5175791, 11 ledgers after ledger 5175780; at least 12 are required".
  - Nothing is submitted, because `/verify` only simulates.
- A well-formed but malformed payload gets 200 `invalid_exact_stellar_payload_malformed` from real upstream, and `{}` gets 400.
- **PR #33 review follow-up** (`/code-review`, 10 findings, each checked against `@x402/stellar` 2.28.0 and `@stellar/stellar-sdk` 16.3.0):
  - Fixed: the facilitator's muxed address (decision 8), a NaN fee-stats bid (9), a fixed bid at or above the ceiling (10), `MIN_VALIDITY_LEDGERS` 1 (11), and the `verified` log now carries `extra.reason` as `reason`.
  - Simplified: `fees.pool.inclusionFee` is always the provider function; the pool turns a number into the same function anyway.
  - Not changed, with reasons: decisions 12 and 13, and two findings that didn't hold. `addressOf` can't throw on a client's address: SDK 16.3.0's `Address.fromScAddress` reads all five ScAddress kinds (G, C, M, B, L, measured), and upstream has already read the same addresses inside its own `try`. The smoke script's `freePort()` race stays: it is a hand-run testnet script, not in CI, and `main()` requires `PORT` 1–65535; a clash shows as EADDRINUSE and a rerun fixes it.
  - Tests: facilitator 74 → 80, signer-pool 98 → 99. Removing the facilitator from the checked set fails the 4 new muxed tests; removing the NaN guard fails the new signer-pool test. The testnet smoke still passes both checks.
- **Adam's PR #33 review** (2026-10-14, 8 comments, each checked against the code):
  - Fixed: the bid counted once at `/verify` and twice in the pool (decision 14), a `MAX_FEE_STROOPS` that the fee-stats floor always exceeds (15), `unexpected_verify_error` as a 500 (16), the `maxTimeoutSeconds` bound in the too-soon message and in AD-22 (17), and a blank fee-stats percentile cached as 0 (now only a whole-number string counts as a reading).
  - `main()`'s verifier wiring is now `buildVerifier(config, rpc, makeScheme)`, tested for the key, the first RPC URL, the ceiling and twice the bid, and that a configured channel is rejected through it.
  - `fee-agreement.test.ts` runs real upstream `ExactStellarScheme` (against a local JSON-RPC stub) and the real pool on the same resource fees, and both refuse from `MAX_FEE_STROOPS − 2 × bid + 1` up. At `MAX − bid` the old wiring passed `/verify` and failed the pool.
  - Smaller: AD-3 names the network check, two comments re-wrapped to 100 columns, `scripts/` typechecked.
  - Left for 0020: `/supported` could advertise the shortest `maxTimeoutSeconds`.
  - Testnet smoke re-run after the fixes (2026-10-14): the payment is `isValid: true` with twice the bid in upstream's fee check, and the channel facilitator rejects it with `extra.reason` set.
  - Tests: facilitator 80 → 90, signer-pool 99. Counting the bid once fails 4 tests, removing the throw fails 2, and the old `Number.isFinite` reading check fails the blank-percentile test.
- **Adam's PR #33 re-review at db484c7** (2026-10-14, 9 comments and a list of smaller points, each checked against the code):
  - Fixed: an upstream call with no deadline (decision 18), a non-integer `amount` as a 500 (19), a non-string `payer` (20), the too-soon hint's bound (17, reworded), `fees` built inside `buildVerifier` (21), RPC URLs and keys in upstream's stderr (22), http and credential RPC URLs that boot and then fail every `/verify` (23), and a V0 envelope as a 500 (24).
  - Tests pin the wiring: `build-verifier.test.ts` checks the facilitator's muxed address and auth at `CURRENT + 4` (valid) and `+ 3` (too soon); `main.test.ts` posts a pubnet payment to the real `main()` and gets `invalid_network`; `verify-route.test.ts` and `verify.test.ts` use an `accepted` whose amount differs from the requirements, and the route test compares the whole body. Each of Adam's seven surviving mutants (`accepted` passed as the requirements, `facilitator: ""`, `minValidityLedgers: 0`, `latestLedger` 0, a stub verifier in `main()`, no `maxTransactionFeeStroops`, a `res.json` that drops fields) now fails 1–3 tests.
  - Smaller: `FEE_STATS_MIN_STROOPS` is exported from `signer-pool` instead of copied, `DEFAULT_ESTIMATED_LEDGER_SECONDS` is imported from upstream, the `feeStroops` docstring moved to it, the `fees.ts` docstring says the bid agrees only within one 30 s reading, and a 103-column comment is re-wrapped. Spine AD-3, AD-10 and AD-22 and ADRs 0004 and 0007 are amended.
  - Left for 0009, from the review: the `/settle` expiry recheck at the pool's floor of 2 (spine AD-22 says so), the same string check on `SettleResponse.payer`, an `accepted` that differs from the requirements in the `/settle` tests, and the answer for `FeeLimitError` or `LedgerBoundError` after `/verify` accepted.
  - Spawned 0045: upstream verify reads only `RPC_URLS[0]`.
  - Testnet smoke re-run after the fixes (2026-10-14): the payment is `isValid: true`, and the channel facilitator rejects it with `extra.reason` set.
  - Tests: facilitator 90 → 102, signer-pool 99.
- **Adam's follow-up on the console capture** (2026-10-14, 2 comments, PR approved): the capture now lasts for the process, and its format keeps stacks, causes and JSON-RPC error objects (decision 22, reworded). `main.test.ts` runs the real server against an RPC that answers 503 with a key in its URL; neither stdout nor stderr contains the key, and with the capture not installed the test fails. Tests: facilitator 102 → 103.

**Modified tests:**
- `main.test.ts` no longer expects 501 from `/verify`, and passes a stub `verify` to `start()`.
- `config.test.ts` expects the new `MIN_VALIDITY_LEDGERS` default of 4.
- `fees.test.ts` expects `fees.pool.inclusionFee` to be the provider function with a fixed bid too, not the number 500 (review simplification).
- `fees.test.ts` expects upstream's scheme to be built for twice the bid (decision 14).
- `config.test.ts` expects a fixed bid below half of `MAX_FEE_STROOPS`, not below all of it (decision 14).
- `verify.test.ts`'s earliest-expiry test uses a `maxTimeoutSeconds` of 300, so its message carries no `maxTimeoutSeconds` hint (decision 17).
- `verify.test.ts`'s hint test expects the ledger-based wording, not "must be at least 65" (decision 17).
- `config.test.ts`'s mapping test uses an https fallback URL on pubnet, not http (decision 23), and the URL test expects the "without credentials" message.
- `build-verifier.test.ts` passes `fees` to `buildVerifier` (decision 21), and `payload()` takes an account and an expiry.
- `main.test.ts`'s SIGTERM test first posts to `/verify` (re-review: `main()` wiring).

## Issues Encountered

- **Upstream logs with `console.error`.** On a bad payload or a failed RPC call, upstream prints the whole error to stderr, an AxiosError with the RPC URL in it. Fixed in the re-review (decision 22).
- **Upstream reads one RPC URL and Horizon.** `rpcConfig` takes one URL, and the ledger close-time estimate comes from Horizon. So upstream doesn't fail over with `RPC_URLS`: with the first URL down, every `/verify` is a 500. Follow-up 0045, before pubnet.

## Design Decisions

### Emerged

1. **A channel problem carries two codes** (Oskar, 2026-10-13). `invalidReason` is upstream's code for the same problem with the facilitator's address (`…_unsafe_tx_or_op_source`, `…_facilitator_is_payer`, `…_facilitator_in_auth`), so any x402 client understands it; ADR 0005 counts channels as the facilitator. `extra.reason` is our own `invalid_exact_stellar_payload_channel_account`, which tells our check apart from upstream's. The validity check has its own code, `invalid_exact_stellar_signature_expiration_too_soon`, named after upstream's `…_too_far`.
2. **The network check comes before upstream** (confirmed by Oskar, 2026-10-13). Upstream would verify a `stellar:pubnet` payload against pubnet's default RPC on a testnet process. We answer `invalid_network` instead.
3. **Muxed addresses count as their base account** (confirmed by Oskar, 2026-10-13) in the channel check. Upstream compares plain strings, so an `M…` address of a channel would otherwise pass.
4. **The validity check uses the earliest-expiring auth entry**, because the transaction can't land once any of its auth entries expires.
5. **`/verify` checks the fee with the pool's current bid** (option 5, Oskar, 2026-10-13). Upstream takes its inclusion bid as a constructor value, so `upstreamAtCurrentBid` reads the bid on each `/verify` and builds a new `ExactStellarScheme` when it has changed. Without `INCLUSION_FEE_STROOPS`, the bid comes from one fee-stats provider shared with the pool (p90, 100–10,000 stroops, cached 30 s). Rejected alternatives:
   - a fixed 100-stroop floor: lets through payments the pool then refuses when fees are high;
   - the pool's highest bid: rejects payments that would settle;
   - a required fixed bid: the pool stops following the market;
   - our own second simulation: extra RPC work, and it repeats upstream's check.

   Fee escalation under load can still raise the pool's bid after `/verify`; the pool checks its own total before signing.
6. **Verification is injected as `Verify` in `AppDeps`,** so the HTTP tests need no RPC, and `/settle` can reuse the same function.
7. **`MIN_VALIDITY_LEDGERS` defaults to 4, not 12** (Oskar, 2026-10-13). 12 was the interim value from 0017. Upstream's client signs auth for exactly `maxTimeoutSeconds` (12 ledgers at 60 s), so at least one ledger later only 11 are left, and 12 rejected nearly every payment on testnet. 4 is AD-22's floor: 2 for the pool plus about 2 of channel wait. AD-22 now says the minimum must stay well below the client's signing window.
8. **The facilitator's own address is checked in muxed form too** (Oskar, 2026-10-13, PR #33 review). Upstream compares the facilitator address as a plain string, so an `M…` form of it passed as the transaction source, an operation source and `from` (measured). `createVerifier` takes `facilitator` and checks it with the channels. A hit keeps upstream's `invalidReason` and carries our own `extra.reason`, `invalid_exact_stellar_payload_facilitator_muxed`, so the logs tell it apart from a channel hit.
9. **A fee-stats percentile that isn't a number counts as a failed read** (Oskar, 2026-10-13), fixed in `signer-pool`'s `feeStatsInclusionFee`, not only in the facilitator. `Math.max(100, NaN)` is NaN, which turned upstream's fee-ceiling check off and would also have reached the pool's bid. The provider falls back to the last good reading or the 100-stroop floor, as on an RPC error.
10. **`INCLUSION_FEE_STROOPS` must be below `MAX_FEE_STROOPS`** (half of it since decision 14). The ceiling also covers the resource fee, which a Soroban transaction always pays, so a fixed bid at or above it rejected every payment at runtime. It is now a `ConfigError` at boot. A fee-stats bid (up to 10,000) is not checked against the ceiling: there a low ceiling is a deliberate cap, not a sure failure.
11. **`MIN_VALIDITY_LEDGERS` is at least 2.** `signer-pool` refuses a call when `latest + 1 >= maxLedger` (`SPARE_LEDGERS` = 1), so with 1 the pool would refuse at `/settle` what `/verify` accepted, as AD-22 says.
12. **The channel check stays after upstream `verify()`,** although running it first would skip a simulation for a payload that uses a channel. AD-3 and the spine fix the order (upstream first, the first rejection is the answer; upstream's own error is thrown, decision 16), `channelProblem` relies on upstream having checked the payload's shape, and running it first saves nothing against abuse: anyone can make us simulate with a payload that uses no channel. Rate limits (0023) cover that.
13. **`parsePaymentRequest` passes the client's objects on, not zod's output.** Measured on `@x402/core`'s v2 schemas: the only transform is `resource: null` → `undefined`, and the other difference is that unknown keys are stripped. Upstream reads neither, so the parsed output would change nothing; the docstring states the contract.
14. **`/verify` counts the bid twice, as the pool pays it** (Adam, PR #33 review, 2026-10-14). The pool settles under a fee bump and refuses when the resource fee plus twice the bid is above the ceiling (CAP-15: the inner operation and the bump each pay it). Upstream adds its `inclusionFeeStroops` once, so a resource fee between `MAX − 2 × bid` and `MAX − bid` passed `/verify` and then failed `/settle` with `FeeLimitError`, after the resource was served. Upstream now gets `settlementInclusionFee(bid)` = 2 × bid, and a fixed bid must be below half of `MAX_FEE_STROOPS`. AD-10 says so.
15. **Without a fixed bid, `MAX_FEE_STROOPS` must be above 200** (Adam, 2026-10-14), twice the fee-stats floor of 100. At 200 or below, every payment is refused. This refuses only that case: a ceiling just above it, such as 201, boots and still refuses every typical (~41k stroop) transfer. That is a deliberate cap, as in decision 10, not a sure failure the config can see.
16. **Upstream's `unexpected_verify_error` is a 500** (Oskar, 2026-10-14, on Adam's question). Upstream catches every exception, mostly a failed call to its one RPC URL, and answers `isValid: false`. Passed on as a 200, an RPC outage made every payment look invalid and logged nothing as an error. `createVerifier` now throws on it, so `/verify` answers 500 and logs `http_error`, as AC 4 says for an unexpected error. An event upstream can't decode is another source of this code and also a 500. A third, `BigInt` on a non-integer `amount`, came from the caller's input; it is a 400 now (decision 19).
17. **The too-soon message says when `maxTimeoutSeconds` is too short** (Adam, 2026-10-14, reworded in the re-review). Upstream's client signs for ⌈maxTimeoutSeconds / ledger time⌉ ledgers, with the ledger time from Horizon, and a varying number of ledgers passes before `/verify`, so no exact bound exists. The message compares ledgers with upstream's default 5 s: when ⌈maxTimeoutSeconds / 5⌉ is at most `minValidityLedgers`, it ends "maxTimeoutSeconds 20 is about 4 ledgers, so it should be well above 20". AD-22 says "well above `minValidityLedgers × 5`", without "every payment".
18. **Upstream `verify()` has a 10 s deadline** (Adam, re-review). Upstream's RPC and Horizon clients have no timeout, so a hanging endpoint held `/verify` open for minutes. `createVerifier` races the call against `upstreamTimeoutMs` (10,000, as `FallbackRpc`) and throws `UpstreamTimeoutError`, a 500. Upstream's request keeps running; it can't be cancelled from outside.
19. **A non-integer `amount` is a 400** (Adam, re-review). `@x402/core`'s schema takes any non-empty string, and upstream's `BigInt(amount)` throws inside its `try`, which decision 16 turned into a 500 that anyone could cause with no RPC call. `parsePaymentRequest` requires digits.
20. **Upstream's `payer` passes on only as a string** (Adam, re-review). Upstream sets it from `from` before any signature check, so a client could make it a number (x402 clients reject the answer) or an i128 (`res.json` throws on the bigint). `createVerifier` drops a non-string `payer`.
21. **`main()` builds `fees` once and passes it to `buildVerifier`** (Adam, re-review), so 0009 builds the pool from the same `fees.pool`. Two `feeSettings` calls would mean two fee-stats providers with separate 30 s caches, which can disagree on the bid. AC 5 stays open until the pool is wired.
22. **Every `console.error` goes through our logger, for the life of the process** (Adam, re-review and its follow-up). Upstream writes the whole AxiosError of a failed RPC call to stderr, with the URL in it three times, and ADR 0011 plans for RPC URLs with keys. `captureConsoleError` logs one `console_error` event at error level: errors as name, message, stack and one level of cause, other arguments as JSON (the SDK throws JSON-RPC errors as plain objects) or text, and every URL reduced to its host. Formatting never throws. Upstream isn't the only writer: the cataloger and Node also write there, so the event name is neutral and the level is error, which `LOG_LEVEL=error` still shows. `main()` restores the original only when the start fails, not on `close()`: an upstream call cut off by the deadline keeps running after SIGTERM, and its error would reach stderr.
23. **RPC URLs must be https outside testnet, and carry no credentials** (Adam, re-review). Upstream's RPC client refuses http outside testnet, and its HTTP client refuses `user:pass@` URLs, so both configs booted and then failed every `/verify` with a 500.
24. **A V0 envelope is rejected as malformed before upstream** (Adam, re-review). Upstream parses it and passes its checks, then `assembleTransaction` throws on it, a 500. Checked with `xdr.TransactionEnvelope`; anything that doesn't decode is still upstream's to reject.

## Future Work

- 0045: fail over upstream verify across `RPC_URLS` before pubnet.
- 0009 (in its own task, see the re-review notes): the `/settle` expiry recheck at 2, the `payer` string check, `accepted` in the tests, and the answer for `FeeLimitError`/`LedgerBoundError` after `/verify` accepted.
- 0020: `/supported` could advertise the `maxTimeoutSeconds` bound.
