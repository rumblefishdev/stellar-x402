---
id: "0036"
title: "AWS KMS Ed25519 signer for the mainnet facilitator key"
type: FEATURE
status: backlog
related_adr: ["0011"]
related_tasks: ["0014", "0026"]
tags: [facilitator, signer-pool, keys, mainnet, priority-low, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
  - ../../../packages/signer-pool/src/types.ts
history:
  - date: "2026-10-09"
    status: backlog
    who: claude
    note: "Spawned from 0014 future work: ADR 0011 moves the mainnet key into AWS KMS after a spike."
---

# AWS KMS Ed25519 signer for the mainnet facilitator key

## Summary

ADR 0011 keeps the testnet facilitator key in SSM and moves the mainnet key into AWS KMS, so the
raw key never exists in the process or in the shared AWS account. This task proves that KMS
signatures are valid on Stellar and adds a `TransactionSigner` backed by KMS.

**Lane:** Platform

## Context

- The pool already takes any `TransactionSigner` (`packages/signer-pool/src/types.ts`).
- KMS signs Ed25519 since November 2025: key spec `ECC_NIST_EDWARDS25519`, algorithm
  `ED25519_SHA_512` with `MessageType: RAW`. Stellar signs the 32-byte transaction hash with pure
  Ed25519, so this should match. `ED25519_PH_SHA_512` would not.
- Not documented: the signature encoding (expected raw 64 bytes) and importing an existing seed.
- Cost: $1 per key per month, $0.15 per 10k signs; every settlement signs at least once.
- Details in task 0014's `R-cloud-container-options` note (KMS and Ed25519).

## Implementation

- Spike on testnet: sign a transaction hash with KMS and verify it with `stellar-base`; derive the
  G-address from `GetPublicKey` (the last 32 bytes of the SPKI).
- A KMS `TransactionSigner` in `apps/facilitator/src/adapters/`, chosen by config.
- Key policy: only the mainnet task role may `Sign`.
- Measure the added latency per settlement.

## Acceptance Criteria

- [ ] Given a KMS Ed25519 key, when it signs a testnet transaction through the pool, then the
      transaction is accepted on chain
- [ ] Given the config, when the facilitator starts with the KMS signer, then no secret seed is
      read from the environment
- [ ] Given the key policy, when any role but the mainnet task role calls `Sign`, then it is denied
