---
id: "0016"
title: "Signer pool T1 prerequisites and the @x402 2.28 upgrade"
type: FEATURE
status: backlog
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
---

# Signer pool T1 prerequisites and the @x402 2.28 upgrade

## Summary

Three small changes to `packages/signer-pool` that the T1 facilitator (0009) depends on, plus the
workspace move to `@x402` 2.28. The M1 architecture review found that the spine's settlement rules
can't be met with the library as it is.

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

- [ ] `onSigned` is awaited before each send; a rejected `onSigned` sends nothing
- [ ] `maxLedger` bounds the transaction and refuses calls that can't fit
- [ ] The XDR fixture test passes on SDK 16.x
- [ ] Every `@x402/*` package in the workspace resolves to one `~2.28.0` version and `@stellar/stellar-sdk` stays on `^16.3.0`
- [ ] Existing signer-pool tests still pass; any changed test is documented
