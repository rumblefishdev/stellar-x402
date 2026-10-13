---
id: "0036"
title: "AWS KMS Ed25519 signer for the facilitator key"
type: FEATURE
status: backlog
related_adr: ["0011"]
related_tasks: ["0014", "0026", "0039"]
milestone: 1
tags: [facilitator, signer-pool, keys, priority-high, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
  - ../../../packages/signer-pool/src/types.ts
history:
  - date: "2026-10-09"
    status: backlog
    who: claude
    note: "Spawned from 0014 future work: ADR 0011 moves the mainnet key into AWS KMS after a spike."
  - date: "2026-10-13"
    status: backlog
    who: stkrolikiewicz
    note: "Now covers both networks and blocks the testnet deploy: ADR 0011 revised for the Hetzner server (0039)."
---

# AWS KMS Ed25519 signer for the facilitator key

## Summary

ADR 0011 (revised in 0039) runs the facilitator on the company Hetzner server and keeps the
facilitator key in AWS KMS on both networks, so the raw key never reaches the server. This task
proves that KMS signatures are valid on Stellar and adds a `TransactionSigner` backed by KMS. It
is a prerequisite of the testnet deploy (0026).

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
- Key policy:
  - an explicit deny on `kms:Sign` for every principal but the network's signing role;
  - key administrators can't sign;
  - only a break-glass role may `DisableKey` or `ScheduleKeyDeletion`;
  - the stack keeps the key on delete (`RETAIN`).
- The Hetzner server gets short-lived credentials through IAM Roles Anywhere (a certificate on the
  server). The role may sign only with its network's key and only from the server's IP
  (`aws:SourceIp`), so leaked credentials can't sign from elsewhere.
- CloudTrail alarms on `Sign` by another principal, key-policy changes, `CreateGrant`,
  `DisableKey` and `ScheduleKeyDeletion`.
- Decide recovery. A KMS key can't be exported, so losing it locks every channel and the fee
  account. The options:
  - an offline backup signer on each account;
  - small balances topped up from an offline account.
- Measure the added latency per settlement.

## Acceptance Criteria

- [ ] Given a KMS Ed25519 key, when it signs a testnet transaction through the pool, then the
      transaction is accepted on chain
- [ ] Given the config, when the facilitator starts with the KMS signer, then no secret seed is
      read from the environment
- [ ] Given the key policy, when any role but the network's signing role calls `Sign`, then it is denied
- [ ] Given a key administrator, when they call `DisableKey` or `ScheduleKeyDeletion`, then it is denied; only the break-glass role may
