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

> Research and a spike are done; the recommendation awaits okarcz's review. The full report is
> [`reports/Hetzner signer key custody.md`](<reports/Hetzner signer key custody.md>), built from
> the four notes in `research_notes/Hetzner signer key custody/`; the first, shorter comparison is
> [`notes/R-key-custody-options.md`](notes/R-key-custody-options.md).

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

- [x] Options compared for Hetzner, with sources (`notes/R-key-custody-options.md`)
- [x] Vault Transit's Ed25519 shown to make valid Stellar signatures, on testnet (`spike/`)
- [ ] okarcz picks the custody option, unseal and recovery
- [ ] An ADR records it and supersedes ADR 0011's custody part; 0036 and 0026 are updated

## Implementation Notes

- **Spike** (`spike/`, Docker dev servers): Vault 2.1.2 and OpenBao 2.7.1 both sign the 32-byte
  transaction hash with pure Ed25519, accepted by `stellar-sdk`; an imported `S…` key keeps its
  G-address; non-exportable keys refuse export; ~6 ms a signature locally. A `createAccount`
  signed only by OpenBao landed on testnet (`26a93987…`, ledger 5210493).
- **No Stellar plugin exists**: Transit works because Stellar keys are plain Ed25519.
- **Deep research** (2026-10-15): AWS KMS from Hetzner (pure Ed25519 since 2025-11-07, seed
  import documented, untested on Stellar, cross-cloud on every settlement), the other managed
  KMS/HSM services and custody APIs, self-hosted options and Stellar-level controls.
- **Gap in our code, found by the research:** `packages/signer-pool/src/setup.ts` gives the
  facilitator key weight 1 and leaves every channel threshold at 0, so the hot key alone can
  change signers on every channel. Thresholds and a cold recovery signer are mainnet blockers
  under any custody option.

## Design Decisions

### Emerged

1. **OpenBao over Vault, if Transit is chosen** (proposal): API-compatible (the spike passed on
   both), MPL-2.0 rather than BSL, and its HSM seal is open source.
2. **The same signer on testnet and mainnet** (proposal), unlike ADR 0011's split.

## Future Work

- The ADR, then a Transit `TransactionSigner` in `apps/facilitator/src/adapters/`, after the
  choice.
