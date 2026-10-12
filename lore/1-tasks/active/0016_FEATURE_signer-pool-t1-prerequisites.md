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
> testnet smoke run done; in review (PR #22). The review's findings are fixed and the smoke run
> was repeated.

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

Branch `lore-0016-signer-pool-t1-prerequisites`. signer-pool: 92 tests (73 before, +19, 9 of
them from the PR #22 review); facilitator 46 and bazaar 40 unchanged on 2.28. Build, typecheck,
lint and format pass.

- **`onSigned`** (`src/submitter.ts`): typed `(hash) => void | Promise<void>` and awaited in
  `sendAndConfirm` before the first send, so also before a rebuild's send after `txBadSeq`. A
  throw or rejection becomes `SignedHookError` (with the hook's error as `cause`); nothing is
  sent, the channel goes back to the pool with its sequence untouched, and the `refused` event
  has the new reason `on-signed`. The wait ends at the envelope's time bound (a timer, cleared
  when the hook settles): a hook still running then is a `SignedHookError` too, so a hung store
  write can't hold the channel. If a bound passed while the hook ran, the result is `expired`
  and nothing is sent.
- **`maxLedger`** (`SubmitOptions`): the last ledger the transaction may land in, inclusive, so
  the caller passes `signatureExpirationLedger` as is. The envelope gets the ledger bound
  `maxLedger + 1` next to its time bound. After simulation, a call with no spare ledger (it could
  land only in `sim.latestLedger + 1` or not at all) is refused with `LedgerBoundError` before
  signing (refusal reason `ledger-bound`). A prepared-ahead envelope with no spare ledger is
  rebuilt (and then refused), and confirmation reports `expired` once the ledger bound passes
  instead of waiting for the time bound. A send the network refuses with `txTooLate` is reported
  `expired`, not `rejected`: nothing was applied. A `maxLedger` that is not a positive integer
  below 2^32 − 1 (`NaN`, a fraction) throws `RangeError` before a channel is taken.
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
  report. The script wraps `sendTransaction`: a hash sent before its write finished is recorded
  at the send, and the guard calls' sends are counted at the RPC. Run after the review fixes,
  2026-10-12 on `CAL7SBTO…V2VC`, 5 channels: 20/20 success in 4 ledgers (5,157,268–5,157,271),
  every hash stored before its send, every landing within `maxLedger` (envelope ledger bound
  5,157,467 = expiry + 1), a call with `maxLedger` at the current ledger refused with
  `LedgerBoundError`, a rejected `onSigned` refused with `SignedHookError`, and zero sends by
  either. 15 envelopes prepared ahead and used; fees 824,469 stroops in total (41,223 average),
  which is exactly the facilitator's balance drop.

**Changed tests:**
- `resilience.test.ts`, "calls onSigned with the hash before the first send…": the hook was
  `(h) => signed.push(…)`, which returns a number and no longer fits `void | Promise<void>`. Now
  `(h) => void signed.push(…)`. Type-only; the assertions are unchanged.
- `settlement-guards.test.ts`, "refuses before signing a call that can't land by maxLedger": the
  call that succeeds now has `maxLedger` 2 ledgers ahead, not 1, and the 1-ahead call is refused
  too. Intentional: one spare ledger is kept (decision 9).
- `settlement-guards.test.ts`, the pipelined rebuild test: `maxLedger` 5 ahead instead of 2, and
  renamed "rebuilds a pipelined envelope with no spare ledger left, then refuses it". At 5 it
  fails without the spare ledger, so it covers the margin in the prepared-ahead check.

## Issues Encountered

- **PR #22 review** found that the awaited `onSigned` had no time limit (a hung write held the
  channel forever), that a slow write could let the bound pass so the send came back `rejected`
  with `txTooLate`, that `maxLedger` was not validated (`NaN` turned the guard off), that calls
  were accepted with no spare ledger, and that two smoke `guards` checks could not fail: one
  checked `stored` after the run, the other compared final results, which a send followed by a
  throw doesn't change. All fixed; the smoke run above is the repeat with the fixed checks.

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
7. **The `onSigned` wait ends at the time bound, on a timer.** Past it the envelope can't land
   anyway. A timer rather than the ledger clock, so a quick write costs no `getLatestLedger`
   poll; the timer is cleared when the hook settles.
8. **`txTooLate` on send is `expired`.** The network refused it at the door, so nothing was
   applied and the sequence was not used. This covers every gap between the last bound check
   and the send (signing, the hook, a stale clock).
9. **One spare ledger** (`SPARE_LEDGERS = 1`), chosen in the PR #22 review. A call that could
   land only in the next ledger is refused before signing, and a prepared-ahead envelope with one
   ledger left is rebuilt (and refused), rather than sent to miss it. The cost: a call that
   would just have made it is turned away and the client signs again.
10. **The prepared-ahead check keeps reading the ledger clock**, against the review's
    suggestion to poll first. There the clock is fresh: the previous holder's confirmation polled
    it until that transaction was final, and a test written for the stale case passed on the old
    code. A fresh read would add a `getLatestLedger` round trip to every pipelined settlement; a
    ledger that slips through ends `expired` (decision 8).
11. **An invalid `maxLedger` throws `RangeError`** before a channel is taken, with no `refused`
    event: it is a caller bug, like the constructor's checks.
