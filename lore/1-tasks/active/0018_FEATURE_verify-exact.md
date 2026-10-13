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

- [ ] Given a valid `exact` payload on `stellar:testnet`, when `/verify` is called, then it returns 200 with `{isValid: true, payer}`, using upstream `ExactStellarScheme.verify()`; we never re-implement upstream's signature, scope, simulation or event checks
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
- **Local testnet run**: the server on testnet answers a well-formed request through real upstream with 200 `invalid_exact_stellar_payload_malformed`, and `{}` with 400. A valid signed payment (AC 1) is not run yet: it needs a funded client key.

**Modified test:** `main.test.ts` no longer expects 501 from `/verify`, and passes a stub `verify` to `start()`.

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

