---
id: "0047"
title: "Choose how the facilitator keeps its signing key on Hetzner"
type: RESEARCH
status: active
milestone: 1
related_adr: ["0011"]
related_tasks: ["0036", "0026", "0014", "0044"]
tags: [facilitator, keys, security, hetzner, priority-high, effort-small, payments]
links:
  - ../../../../docs/adr/0011-facilitator-hosting.md
  - ../../../../docs/architecture/m1-spine.md
  - ../../../../docs/threat-model.md
history:
  - date: "2026-10-15"
    status: backlog
    who: okarcz
    note: "Created: the facilitator moves to Hetzner, so ADR 0011's AWS SSM and KMS custody no longer applies."
  - date: "2026-10-15"
    status: active
    who: okarcz
    note: "Started right away; compare a KMS signer with HashiCorp Vault / OpenBao Transit."
---

# Choose how the facilitator keeps its signing key on Hetzner

## Summary

The facilitator now runs on Hetzner, not AWS. ADR 0011 kept its key in AWS SSM on testnet and
in AWS KMS on mainnet (0036), and neither exists on Hetzner. Research where the key lives now,
whether a KMS signer is still the best option, and how HashiCorp Vault's Transit engine
compares. Record the choice in an ADR that supersedes ADR 0011's custody part.

**Lane:** Payments

## Status: Active

> Started 2026-10-15 on branch `lore-0047-hetzner-key-custody`.

## Context

- Spine AD-12: one facilitator key per network, the only signer of every channel; the pool gets it
  only as a `TransactionSigner`, so a remote signer can replace it.
- ADR 0011: SSM SecureString (testnet) and AWS KMS Ed25519 (mainnet, 0036). Both are AWS-only.
- We were told Vault Transit can create keys and sign with them like KMS, and supports Stellar
  keys.
- Hetzner has no KMS or HSM service.

## Implementation

- Compare: the key as a host secret, a cloud KMS called from Hetzner, Vault/OpenBao Transit on
  Hetzner, a hardware HSM, and Stellar-level limits.
- Check the Transit claim with a spike: sign a Stellar transaction with a Transit key, import an
  existing key, land a transaction on testnet.
- Recommend one, with its unseal, recovery and deployment.

## Acceptance Criteria

- [ ] Options compared for Hetzner, with sources
- [ ] Vault Transit's Ed25519 checked for valid Stellar signatures, on testnet
- [ ] okarcz picks the custody option, unseal and recovery
- [ ] An ADR records it and supersedes ADR 0011's custody part; 0036 and 0026 are updated
