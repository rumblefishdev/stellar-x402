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

- Our own code calls it too: `apps/facilitator/src/main.ts:354` (the `latestLedger` check of
  `/verify` and `/settle`), `packages/signer-pool/src/ledger-clock.ts:52` and
  `packages/signer-pool/src/fallback-rpc.ts:148,246`.

## Implementation Plan

Move the lockfile from 16.3.0 to 16.4.1. Raise the `package.json` ranges only if pnpm needs it.

## Acceptance Criteria

- [x] `pnpm why @stellar/stellar-sdk` shows one version, 16.4.1, also under `@x402/stellar`
- [x] typecheck, lint and format pass
- [x] tests pass for the packages that use the SDK (see the timing failures below)
- [x] `apps/facilitator/scripts/settle-smoke.ts` finishes on real testnet

## Design Decisions

### From Plan

1. **Only the lockfile moves**: the `^16.3.0` ranges and `@x402/stellar`'s own range allow 16.4.1.

### Emerged

2. **The lockfile entries are edited, not regenerated**: `pnpm -r update @stellar/stellar-sdk
--no-save` also moved rolldown, postcss and others, and rewrote the `seller-fetch` entry. The edit
   changes the SDK and axios entries only (15 lines). `pnpm install --frozen-lockfile` accepts it,
   and `pnpm install --lockfile-only` leaves it unchanged.

## Issues Encountered

- **`pnpm install --frozen-lockfile` didn't relink after the lockfile went back to 16.3.0**: the
  checkout stayed on 16.4.1, so a comparison needs its own clean checkout of each version.
- **Timing tests failed during the comparison, on both versions**: these are the real-budget tests
  of 0074. Measured on the facilitator suite in two clean checkouts:
  - run in turn: 16.4.1 failed 2 of 6 runs, 16.3.0 failed 0 of 6;
  - run side by side, `settle`, `settle-pool` and `migrate` only: 16.4.1 failed 0 of 12, 16.3.0
    failed 1 of 12, with the same durations.

  The side-by-side run shares load and order, so it doesn't show the SDK as the cause. It ran at a
  low load, so it can't rule out a small effect under a high one.
