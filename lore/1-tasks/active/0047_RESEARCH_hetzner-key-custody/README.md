---
id: "0047"
title: "Choose how the facilitator keeps its signing key on Hetzner"
type: RESEARCH
status: active
milestone: 1
related_adr: ["0011", "0013"]
related_tasks: ["0036", "0026", "0014", "0044", "0048"]
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
  - date: "2026-10-19"
    status: active
    who: okarcz
    note: "Decided: OpenBao Transit on the facilitator's server, no cold key (ADR 0013). Unseal key backup holder open."
  - date: "2026-10-20"
    status: active
    who: okarcz
    note: >
      Decided the last open points (B1–B20): the unseal backup set in AWS Secrets Manager with a
      restore drill, a 100 XLM float with a 25 XLM alarm and manual top-ups. ADR 0013 amended. All
      acceptance criteria met; closes when PR #48 merges.
  - date: "2026-10-21"
    status: active
    who: stkrolikiewicz
    note: >
      Taken over from okarcz for the remaining changes and the merge. ADR 0013 follows the PR #24
      review: a socket per network, OpenBao's own unit and limits, AppRole files in tmpfs, and the
      Storage Box named generically.
---

# Choose how the facilitator keeps its signing key on Hetzner

## Summary

The facilitator now runs on Hetzner, not AWS. ADR 0011 kept its key in AWS SSM on testnet and
in AWS KMS on mainnet (0036), and neither exists on Hetzner. Research where the key lives now,
whether a KMS signer is still the best option, and how HashiCorp Vault's Transit engine
compares. Record the choice in an ADR that supersedes ADR 0011's custody part.

**Lane:** Payments

## Status: Active

> **Decided on 2026-10-20** ([S-key-custody-decisions, B1–B20](notes/S-key-custody-decisions.md#backup-and-top-ups-2026-10-20)):
> the unseal backup set (seal key and key ID, recovery key, Borg passphrase, seal config) goes into
> **AWS Secrets Manager** in the account soroban-explorer and prices-api share, proven by a
> quarterly restore drill ([R-unseal-key-backup](notes/R-unseal-key-backup.md)). The fee float is
> **100 XLM with a 25 XLM alarm**, topped up by hand. Left for before mainnet: who makes mainnet
> top-ups.
>
> **Decided on 2026-10-19** ([ADR 0013](../../../../docs/adr/0013-facilitator-key-custody.md),
> [S-key-custody-decisions](notes/S-key-custody-decisions.md)): OpenBao Transit in a container on
> the facilitator's server, the key generated inside and not exportable, auto-unseal from a systemd
> credential, snapshots on the existing Storage Box, and **no cold key**. Open: who holds the
> unseal key backup (an acceptance criterion below) and where top-ups come from.
>
> Research and a spike are done. The full report is
> [`reports/Hetzner signer key custody.md`](<reports/Hetzner signer key custody.md>), built from
> the four notes in `research_notes/Hetzner signer key custody/`; the first, shorter comparison is
> [`notes/R-key-custody-options.md`](notes/R-key-custody-options.md); where OpenBao runs, its cost
> and its link to the facilitator's server are in
> [`notes/R-openbao-on-hetzner.md`](notes/R-openbao-on-hetzner.md). On 2026-10-16 the choice
> between OpenBao and AWS KMS was reopened: OpenBao needs its own machine, and mainnet may unseal
> from a KMS anyway
> ([revisited](notes/R-key-custody-options.md#openbao-or-aws-kms-revisited)). On 2026-10-19
> okarcz said the move to Hetzner was about cost. A leaked key reaches only our own float (about
> 180 XLM at launch), so a separate machine or KMS costs more than it protects. **Preferred
> (okarcz, 2026-10-19), not yet an ADR:** OpenBao on the facilitator's server with auto-unseal,
> plus 0048 and a small float ([R-key-leak-impact](notes/R-key-leak-impact.md)).

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
- [x] okarcz picks the custody option, unseal and recovery (`notes/S-key-custody-decisions.md`)
- [x] An ADR records it and supersedes ADR 0011's custody part; 0036 and 0026 are updated (ADR 0013)
- [x] okarcz decides who holds the unseal key backup, and where; ADR 0013 records it (AWS Secrets
      Manager, any admin of the shared AWS account; B1–B13)

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
  under any custody option; task 0048 covers them.
- **Leak impact** (2026-10-19, [R-key-leak-impact](notes/R-key-leak-impact.md)): the key can't
  move buyers' or sellers' tokens, only the fee account's float and the channels' ~1.5 XLM each.
  A launch float of about 150 XLM (alarm at 50, cold top-ups) caps a leak at about 180 XLM plus
  downtime, which 0048 shortens. A separate OpenBao machine (~€78–144 a year) costs more than
  that. Preferred: OpenBao on the facilitator's server with auto-unseal (the unseal key a root-only
  file outside OpenBao's data and backups); Shamir was rejected for its downtime on every restart.
  A separate machine or a KMS seal is the upgrade once the float or `upto` (0015) raises the
  stakes.

- **Unseal key backup** (2026-10-20, [R-unseal-key-backup](notes/R-unseal-key-backup.md)): a
  restore on a new server needs four items, not one: the seal key with its exact key ID (OpenBao's
  static wrapper refuses another ID), the recovery key (it regenerates a root token, needed for a
  new AppRole login), the Borg passphrase, and the seal config with the OpenBao version. A
  `host`-mode systemd credential opens only on the server that made it, so it is no backup. The
  research recommended a two-person password manager vault; okarcz chose AWS Secrets Manager.
- **Fee float** (2026-10-20): at ~41,200 stroops a typical `exact` settlement (ADR 0003), 100 XLM
  pays for about 24,000 settlements; at 1,000 a day the 25 XLM alarm leaves about 6 days. Table in
  [S-key-custody-decisions](notes/S-key-custody-decisions.md#fee-float-and-top-ups).

## Issues Encountered

- **ADR 0013 said the root token is regenerated with the unseal key.** With a static (auto-unseal)
  seal it is the recovery key; fixed on 2026-10-20.
- **AWS KMS can't hold a backup:** it never returns key material, so "the AWS key manager" became
  Secrets Manager.

## Design Decisions

### From Plan

3. **OpenBao Transit in a container on the facilitator's server** (okarcz, 2026-10-19): the stakes
   (~180 XLM) don't pay for a separate machine or a KMS. Question by question in
   [S-key-custody-decisions](notes/S-key-custody-decisions.md).
4. **No cold key** (okarcz, 2026-10-19): only the hot key is kept. 0048 stays a mainnet blocker
   with a note to re-check its cold-key design. Losing OpenBao's data and the unseal key then loses
   the accounts.
5. **Build order** (okarcz, 2026-10-19): 0036 → 0026 on testnet → 0048 re-check → mainnet.

6. **The unseal backup set in AWS Secrets Manager** (okarcz, 2026-10-20): one secret,
   `x402/production/openbao-backup`, in the AWS account soroban-explorer and prices-api share,
   readable by its admins; no paper copy; made by hand with the CLI; one recovery share; a restore
   drill before mainnet and every quarter (B1–B13).
7. **Fee float 100 XLM, alarm at 25 XLM, no upper limit** (okarcz, 2026-10-20): manual top-ups
   (Friendbot on testnet, the company's exchange account on mainnet), a Slack alarm, a weekly review
   by okarcz that also re-checks the custody against the float (B14–B20).

### Emerged

1. **OpenBao over Vault** (accepted in ADR 0013): API-compatible (the spike passed on both),
   MPL-2.0 rather than BSL, and its HSM seal is open source.
2. **The same signer on testnet and mainnet** (accepted in ADR 0013), unlike ADR 0011's split.
3. **One AWS role on the server, for logs and metrics** (okarcz, 2026-10-21, Stan's comment on
   #48): ADR 0013's "no AWS credentials" now allows the roles ADR 0011 names and justifies, none of
   which may sign or read the backup secret. Accepted in the #24 review; more roles can be added if
   needed and documented, an S3 snapshot fallback with its own write-only role.

## Future Work

- **0036**: the Transit `TransactionSigner` (retargeted from AWS KMS, now Payments).
- **0026**: OpenBao's deployment, snapshots, the testnet key move and the runbook.
- **0048**: re-check the thresholds and recovery design before mainnet.
- **0027**: the fee-bump, low-balance, OpenBao-down and audit-disk alarms.
- **A hosting ADR** for the move to Hetzner: ADR 0011 still describes AWS apart from custody.
- **0026**: the backup secret, the init flags, the CLI steps, the restore drill, the Friendbot
  script, the weekly review, and the mainnet top-up owner (TBD before mainnet).
- **0027**: the Slack low-balance alarm at 25 XLM, and a CloudTrail alarm on reads of the backup
  secret.
