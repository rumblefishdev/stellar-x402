---
id: "0048"
title: "Keep the hot key below the high threshold, with a cold recovery signer"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0003", "0005", "0011"]
related_tasks: ["0047", "0007", "0016", "0020", "0026", "0027"]
tags: [signer-pool, keys, security, mainnet, priority-high, effort-medium, payments]
links:
  - ../../../docs/architecture/m1-spine.md
  - ../../../docs/threat-model.md
history:
  - date: "2026-10-15"
    status: backlog
    who: claude
    note: >
      Spawned from 0047's research (okarcz asked for it): channel setup leaves every threshold at
      0, so the facilitator key alone can change signers on every channel.
  - date: "2026-10-19"
    status: backlog
    who: okarcz
    note: >
      0047 (ADR 0013) declined the cold recovery key for now: keep only the hot key. Still a mainnet
      blocker; re-check this design before mainnet.
---

# Keep the hot key below the high threshold, with a cold recovery signer

## Summary

Every channel is set up with the facilitator key at weight 1, the master key at 0 and **every
threshold left at 0** (`packages/signer-pool/src/setup.ts`, the `setOptions` in channel setup).
Weight 1 then meets the high threshold, so whoever holds the facilitator key can add a signer,
raise the thresholds and lock us out of every channel at once. Losing the key (a deleted KMS key,
a lost OpenBao cluster) freezes every channel for good, since even `AccountMerge` needs high.
Set thresholds so the hot key can settle but not change signers, and add a cold recovery signer
that can. This holds whichever custody option 0047 picks, and is a mainnet blocker.

> **Re-check before mainnet** (okarcz, 2026-10-19): 0047 decided on OpenBao Transit with **no cold
> key**; only the hot key is kept ([ADR 0013](../../../docs/adr/0013-facilitator-key-custody.md)).
> The design below needs a cold key, so it is on hold. Before mainnet, decide again: a cold
> recovery key, another way to keep the hot key below high, or accept the hot key's full power and
> record why. What declining it costs: a stolen key can lock us out of every channel, and losing
> OpenBao's data and its unseal key loses the fee account and every channel. Build order (0047):
> 0036 → 0026 on testnet → this re-check → mainnet. The testnet move to the OpenBao key is signed by
> the current key, in 0026, not cold-signed.

**Lane:** Payments

## Context

- Changing signers or thresholds and `AccountMerge` need the high threshold; Invoke Host Function
  and Payment need medium; a fee bump needs only the fee account's low threshold.
- AD-12 today requires the facilitator key to be each channel's **only** signer, and
  `checkChannel` flags any other signer as `extra-signer` and checks only medium. Both change.
- Each extra signer adds 0.5 XLM of reserve per account, unless a cold account sponsors it.
- A classic transaction holds up to 100 operations, so one cold signature can add or swap the hot
  key on many channels at once.
- Details and sources: 0047's report (`reports/Hetzner signer key custody.md`, on branch
  `lore-0047-hetzner-key-custody`), section "Stellar thresholds, not the custody product, decide
  the blast radius".

## Implementation

- **Channels:** hot key weight 1, cold recovery key weight 2, thresholds low 1 / medium 1 /
  high 2, set by channel setup. Add the recovery signer before raising high, in one `SetOptions`
  sequence, so the account is never locked.
- **The facilitator's own account** (pays fee bumps): master (hot) key weight 1, thresholds
  low 1 / medium 2 / high 2, the cold key at high or above. The hot key can fee-bump but can't
  send a Payment.
- **`checkChannel`:** facilitator weight ≥ max(low, medium) and < high, the recovery key ≥ high,
  no other signer.
- **Migration** for existing channels (testnet), cold-signed and batched.
- **Reserve:** fund the extra 0.5 XLM per channel, or sponsor it from a cold account; decide.
- **Rotation runbook:** add the new hot key with the cold key, switch the facilitator, remove the
  old key (0026's runbook).
- **Amend spine AD-12** and the threat model.

## Acceptance Criteria

- [ ] Given a new channel, when setup runs, then its thresholds are low 1 / medium 1 / high 2 and the facilitator key (weight 1) can't change its signers or merge it, while a settlement still lands
- [ ] Given the facilitator's own account, when it is hardened, then the hot key can sign fee bumps but not a Payment or a signer change
- [ ] Given the cold recovery key, when the hot key is lost or rotated, then one batched, cold-signed transaction moves many channels to a new hot key, tested on testnet
- [ ] Given a channel without the recovery signer or with the hot key at high, when `checkChannel` runs at startup, then the service refuses to start
- [ ] Spine AD-12 and the threat model describe the new signer layout; the reserve choice is recorded
