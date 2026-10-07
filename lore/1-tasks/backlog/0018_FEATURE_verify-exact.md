---
id: "0018"
title: "Verify exact payments"
type: FEATURE
status: backlog
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
- [ ] Given a payload where a channel account appears as the transaction source, an operation source, `from`, or the address of any auth entry (`Address` or `AddressV2`), when `/verify` is called, then it returns `isValid: false` with a reason (AD-5)
- [ ] Given a payload whose auth expires fewer than `minValidityLedgers` ledgers ahead, when `/verify` is called, then it returns `isValid: false` with a reason (AD-22)
- [ ] Given a malformed request body, when `/verify` is called, then it returns 400, and an unexpected error returns 500
- [ ] Given the fee configuration, when the app wires `ExactStellarScheme` and the pool, then one `maxFeeStroops` and one `inclusionFeeStroops` value feed both, and the client's fee is never used (AD-10)
