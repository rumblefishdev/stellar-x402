---
id: "0111"
title: "Move stellar-sdk to 16.4.1, so a buyer can build a payment on protocol 30"
type: BUG
status: active
milestone: 1
related_adr: []
related_tasks: ["0063"]
tags: [dependencies, testnet, priority-high, effort-small]
links:
  - https://github.com/stellar/js-stellar-sdk/releases/tag/v16.4.0
history:
  - date: "2026-11-04"
    status: active
    who: karolkow
    note: "Found while re-running the 0063 testnet smoke. Testnet moved to protocol 30."
---

# Move stellar-sdk to 16.4.1, so a buyer can build a payment on protocol 30

## Summary

Testnet RPC reports protocol 30. With `@stellar/stellar-sdk` 16.3.0, `rpc.Server.getLatestLedger()`
throws while decoding the ledger header, and `@x402/stellar` 2.28.0 `createPaymentPayload` stops on
it, so a buyer can't build an `exact` payment on testnet. Moving the lockfile to 16.4.1 fixes it.

## Status: Active

**Current state:** the lockfile move and its testnet evidence go out as one PR.

## Context

- Measured 2026-11-04: `getVersionInfo` on testnet RPC gives 30.0.0, on mainnet RPC 29.
- The error: `XDR Read Error: unknown StellarValueType member for value 3`, from
  `parseRawLatestLedger` (`src/rpc/parsers.ts:296` in the SDK).
- Source: the v16.4.0 release notes regenerate the bundled XDR from stellar-xdr v30.0. The same
  notes say `Address`, `scValToNative` and their helpers still throw on muxed contract addresses.
- `@x402/stellar` 2.28.0 asks for `^16.3.0`, so 16.4.1 stays inside its range. 17.x does not.

## Implementation Plan

Move the lockfile from 16.3.0 to 16.4.1. Raise the `package.json` ranges only if pnpm needs it.

## Acceptance Criteria

- [ ] `pnpm why @stellar/stellar-sdk` shows one version, 16.4.1, also under `@x402/stellar`
- [ ] typecheck, lint and format pass
- [ ] tests pass for the packages that use the SDK
- [ ] `apps/facilitator/scripts/settle-smoke.ts` finishes on real testnet
