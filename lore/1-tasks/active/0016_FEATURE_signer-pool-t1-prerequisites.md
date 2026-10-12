---
id: "0016"
title: "Signer pool T1 prerequisites and the @x402 2.28 upgrade"
type: FEATURE
status: active
milestone: 1
related_adr: ["0003", "0006"]
related_tasks: ["0007", "0009", "0011", "0012"]
tags: [signer-pool, settlement, priority-high, effort-small, payments]
links:
  - ../archive/0007_FEATURE_facilitator-settlement-submitter.md
  - ../../../docs/architecture/m1-spine.md
  - ../../../docs/planning/m1-epics.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: >
      Spawned from the 0012 M1 architecture review: library changes 0009 needs. The XDR fixture
      moved here from 0011.
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Mapped to M1 Story 1.2 (Payments lane) by 0012. Added the workspace @x402 2.28 upgrade (AD-14)."
  - date: "2026-10-12"
    status: active
    who: okarcz
    note: >
      Work started.
---

# Signer pool T1 prerequisites and the @x402 2.28 upgrade

## Summary

Three small changes to `packages/signer-pool` that the T1 facilitator (0009) depends on, plus the
workspace move to `@x402` 2.28. The M1 architecture review found that the spine's settlement rules
can't be met with the library as it is.

## Status: Active

> Started 2026-10-12 on branch `lore-0016-signer-pool-t1-prerequisites`. Code, tests and the
> testnet smoke run done; in review.

**Story:** [M1 Story 1.2](../../../docs/planning/m1-epics.md#story-12-signer-pool-prerequisites-and-the-x402-228-upgrade) · **Lane:** Payments

## Context

- `onSigned` is a synchronous `(hash) => void` hook, called without being awaited and with errors
  ignored (`submitter.ts` around line 471). An async store write in it can finish after the send,
  and a failed write is lost. AD-16 needs the hash stored durably before the first send.
- The transaction's time bound is a fixed 60 s. It can outlive the client's auth expiry, so we
  pay a fee for a transaction that fails on chain (AD-22).
- The protocol-29 XDR fixture guards the stay-on-SDK-16.x rule (AD-14) and `AddressV2` handling.
  It was in 0011, which isn't in T1.

## Implementation

- **`onSigned`:** make it `(hash) => void | Promise<void>`. The submitter awaits it before every
  send, including rebuilds. A rejection aborts the send, frees the channel and returns a typed
  error.
- **`maxLedger`:** a new submit option. The transaction's ledger bound never goes past it, and a
  call that can't fit is refused before signing.
- **XDR fixture:** recorded testnet XDR for protocol 29 (`AddressV2` credentials, fee bumps,
  `LedgerCloseMeta` v2) parsed by SDK 16.x in a test. Remove the item from 0011.
- **`@x402` 2.28 upgrade (AD-14):** move every `@x402/*` dependency in the workspace to one
  pinned `~2.28.0` and keep `@stellar/stellar-sdk` on `^16.3.0`. The XDR fixture guards this.

## Acceptance Criteria

- [x] `onSigned` is awaited before each send; a rejected `onSigned` sends nothing
- [x] `maxLedger` bounds the transaction and refuses calls that can't fit
- [x] The XDR fixture test passes on SDK 16.x
- [x] Every `@x402/*` package in the workspace resolves to one `~2.28.0` version and `@stellar/stellar-sdk` stays on `^16.3.0`
- [x] Existing signer-pool tests still pass; any changed test is documented

## Implementation Notes

Branch `lore-0016-signer-pool-t1-prerequisites`. signer-pool: 83 tests (73 before, +10);
facilitator 46 and bazaar 40 unchanged on 2.28. Build, typecheck, lint and format pass.

- **`onSigned`** (`src/submitter.ts`): typed `(hash) => void | Promise<void>` and awaited in
  `sendAndConfirm` before the first send, so also before a rebuild's send after `txBadSeq`. A
  throw or rejection becomes `SignedHookError` (with the hook's error as `cause`); nothing is
  sent, the channel goes back to the pool with its sequence untouched, and the `refused` event
  has the new reason `on-signed`.
- **`maxLedger`** (`SubmitOptions`): the last ledger the transaction may land in, inclusive, so
  the caller passes `signatureExpirationLedger` as is. The envelope gets the ledger bound
  `maxLedger + 1` next to its time bound. After simulation, a call whose next ledger
  (`sim.latestLedger + 1`) is past `maxLedger` is refused with `LedgerBoundError` before signing
  (refusal reason `ledger-bound`). A prepared-ahead envelope past its bound is rebuilt (and then
  refused), and confirmation reports `expired` once the ledger bound passes instead of waiting for
  the time bound.
- **XDR fixture** (`test/fixtures/protocol-29/`, `test/xdr-fixture.test.ts`): a 0007 smoke-run
  settlement from 2026-10-06, `b597301a…7052` in testnet ledger 5,054,851. Delegated-bump fee
  bump, the client's `sorobanCredentialsAddressV2` entry, `TransactionMeta` v4, and the ledger's
  `LedgerCloseMeta` v2 (protocol 29), gzipped (165 KB raw, 22 KB stored). The test also checks
  the installed `@stellar/stellar-sdk` is 16.x and `@x402/stellar` is 2.28.x.
  `scripts/record-xdr-fixture.ts` re-records it (testnet RPC keeps about 7 days).
- **2.28 upgrade:** every `@x402/*` range in the 7 workspace `package.json` files moved from
  `~2.27.0` to `~2.28.0`; the lockfile resolves core, stellar, extensions, express, fetch and mcp
  to 2.28.0 only, and `@stellar/stellar-sdk` to 16.3.0 only. `@x402/stellar` 2.28 itself requires
  `@stellar/stellar-sdk` `^16.3.0`.
- **Fake RPC** (`test/fake-rpc.ts`): honours ledger bounds like time bounds (refused at send,
  dropped at close).
- **Testnet smoke** (`scripts/testnet-smoke.ts`): every payment now passes an async `onSigned`
  (a 20 ms write) and `maxLedger` set to the auth expiry, and the run ends with a `guards`
  report. 2026-10-12 on `CAL7SBTO…V2VC`, 5 channels: 20/20 success in 4 ledgers
  (5,156,837–5,156,840), every hash stored before its send, every landing within `maxLedger`
  (envelope ledger bound 5,157,036 = expiry + 1), a call with `maxLedger` at the current ledger
  refused with `LedgerBoundError`, a rejected `onSigned` refused with `SignedHookError`, and
  nothing sent by either.

**Changed tests:**
- `resilience.test.ts`, "calls onSigned with the hash before the first send…": the hook was
  `(h) => signed.push(…)`, which returns a number and no longer fits `void | Promise<void>`. Now
  `(h) => void signed.push(…)`. Type-only; the assertions are unchanged.

## Design Decisions

### From Plan

1. **Awaited `onSigned` with a typed error** (AD-16) and **`maxLedger` refused before signing**
   (AD-22), as the story asks.

### Emerged

2. **`maxLedger` is inclusive.** The network's ledger bound is exclusive; the option takes the
   last ledger the transaction may land in, so the facilitator can pass the client's
   `signatureExpirationLedger` without an off-by-one. The submitter adds 1.
3. **The fit check uses the simulation's `latestLedger`**, not the ledger clock, which is stale
   while nothing is waiting. It costs one simulation for a call that is then refused, and it
   runs before anything is signed.
4. **The fixture comes from the 0007 smoke run**, not the 0035 e2e run: the e2e client signs with
   `sorobanCredentialsAddress`, and only the smoke script uses `AddressV2`. The ledger with the
   fewest transactions was picked to keep the `LedgerCloseMeta` small.
5. **The ledger's apply meta is not compared byte for byte** with `getTransaction`'s meta: the
   two copies differ in change order and timing metrics. The test compares the result and the
   meta version instead.
6. **Two new refusal reasons** in `SubmitterStats`: `on-signed` and `ledger-bound`.
