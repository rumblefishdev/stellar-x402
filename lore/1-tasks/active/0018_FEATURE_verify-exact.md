---
id: "0018"
title: "Verify exact payments"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004", "0005", "0006", "0007"]
related_tasks: ["0012", "0017", "0009"]
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
- [x] Given the fee configuration, when the app wires `ExactStellarScheme` and the pool, then one `maxFeeStroops` and one `inclusionFeeStroops` value feed both, and the client's fee is never used (AD-10)

## Implementation Notes

- **`settlement/verify.ts`**: `createVerifier()` returns the `Verify` function that `/verify` uses and `/settle` (0009) will use. It runs:
  - our network check (this process serves one network);
  - upstream `ExactStellarScheme.verify()`;
  - `channelProblem()`: the transaction source, operation sources, `from` and each auth entry's address (`Address` and `AddressV2`, through upstream's `getAddressCredentials`), with muxed addresses counted as their base account;
  - `authExpiration()`: the earliest `signatureExpirationLedger`, compared with the latest ledger.
- **`settlement/fees.ts`**:
  - `feeSettings(config.fees, rpc)` gives the ceiling, the current inclusion bid and the pool options from one config. The pool and `/verify` share one bid: `INCLUSION_FEE_STROOPS`, or one fee-stats provider. 0009 builds the pool from `fees.pool`.
  - `upstreamAtCurrentBid` gives upstream that bid on every `/verify`.
  - Testnet measurement: the first fee-stats read took 586 ms, including opening the connection; a cached read took 0 ms. A read happens at most once per 30 s, and concurrent callers share it.
- **`http/app.ts`**: `POST /verify` checks the body with `@x402/core`'s v2 schemas (`parsePaymentRequest`, reusable by `/settle`). It answers 400 `bad_request` for a bad body, 200 with the x402 body for any outcome, and 500 when verification throws. It logs one `verified` event.
- **`main.ts`**: builds `ExactStellarScheme` with the facilitator key as its only signer, the first RPC URL, `MAX_FEE_STROOPS` and the current bid. The latest ledger comes from `FallbackRpc` over all `RPC_URLS`.
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

**Modified tests:**
- `main.test.ts` no longer expects 501 from `/verify`, and passes a stub `verify` to `start()`.
- `config.test.ts` expects the new `MIN_VALIDITY_LEDGERS` default of 4.
- `fees.test.ts` expects `fees.pool.inclusionFee` to be the provider function with a fixed bid too, not the number 500 (review simplification).

## Issues Encountered

- **Upstream logs with `console.error`.** On a bad payload, upstream prints raw stack traces to stderr, outside our one-event-per-line JSON log. Not fixed; it only matters for log parsing.
- **Upstream reads one RPC URL and Horizon.** `rpcConfig` takes one URL, and the ledger close-time estimate comes from Horizon. So upstream doesn't fail over with `RPC_URLS`.

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
10. **`INCLUSION_FEE_STROOPS` must be below `MAX_FEE_STROOPS`.** The ceiling also covers the resource fee, which a Soroban transaction always pays, so a fixed bid at or above it rejected every payment at runtime. It is now a `ConfigError` at boot. A fee-stats bid (up to 10,000) is not checked against the ceiling: there a low ceiling is a deliberate cap, not a sure failure.
11. **`MIN_VALIDITY_LEDGERS` is at least 2.** `signer-pool` refuses a call when `latest + 1 >= maxLedger` (`SPARE_LEDGERS` = 1), so with 1 the pool would refuse at `/settle` what `/verify` accepted, as AD-22 says.
12. **The channel check stays after upstream `verify()`,** although running it first would skip a simulation for a payload that uses a channel. AD-3 and the spine fix the order (upstream first, the first failure is the answer), `channelProblem` relies on upstream having checked the payload's shape, and running it first saves nothing against abuse: anyone can make us simulate with a payload that uses no channel. Rate limits (0023) cover that.
13. **`parsePaymentRequest` passes the client's objects on, not zod's output.** Measured on `@x402/core`'s v2 schemas: the only transform is `resource: null` → `undefined`, and the other difference is that unknown keys are stripped. Upstream reads neither, so the parsed output would change nothing; the docstring states the contract.
