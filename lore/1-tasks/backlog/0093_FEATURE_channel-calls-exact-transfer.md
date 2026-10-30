---
id: "0093"
title: "Make the channel the caller of an exact settlement, so the fee account only pays fees"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0003", "0005", "0013"]
related_tasks: ["0036", "0048", "0015", "0006", "0007"]
tags: [signer-pool, keys, security, mainnet, priority-medium, effort-small, payments]
links:
  - ../../../packages/signer-pool/src/submitter.ts
  - ../backlog/0048_FEATURE_channel-signer-thresholds.md
history:
  - date: "2026-10-30"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0036's grilling: the fee account is the operation source of every settlement,
      which only `upto` needs, and it keeps 0048 from limiting the hot key to fees.
---

# Make the channel the caller of an exact settlement, so the fee account only pays fees

## Summary

Every settlement's `invokeHostFunction` names the fee account as its operation source
(`packages/signer-pool/src/submitter.ts:622`). An operation source needs the medium threshold, so
the facilitator key must meet medium on the fee account, which also allows a Payment out of it. An
`exact` settlement doesn't need the fee account there: leaving the operation source unset makes the
channel, the transaction source, the caller. The fee account then only signs the fee bump, which
needs the low threshold (CAP-15), and 0048 can raise the fee account's medium and high above the
hot key's weight.

**Lane:** Payments

## Context

- The shape was measured and chosen for `upto` in 0006: the `upto-proxy` contract calls
  `facilitator.require_auth()`, which the operation source satisfies
  (`lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/R-soroban-auth-model.md:81`).
  0007 then used one shape for every call. No reason is written for `exact`, whose `transfer` is
  authorised by the payer's auth entry alone.
- Measured on testnet: our settlement `355082892c83…` (2026-10-23) has the fee account
  `GBCSI5…` as fee-bump payer and as operation source, the channel `GDNC65…` as transaction source.
  The public x402.org facilitator's `1bc53d50a888…` (2026-10-15) leaves the operation source unset.
- Measured on testnet (2026-10-30, a throwaway fee account F with key K, one channel, a native-XLM
  `transfer` fee-bumped by F): with F's thresholds at 0, both shapes land (no operation source
  `7b2e53e8…`, F as operation source `178e55b2…`). After F's thresholds are raised to low 1 /
  medium 2 / high 2 (`fcf0e02a…`), the shape with no operation source still lands (`b5a096a2…`,
  10,493 stroops), F as operation source is refused at submit with `opBadAuth` and no fee charged,
  and a 10 XLM Payment out of F is refused the same way. The shape with no operation source is 36
  bytes and 79 stroops smaller.
- Upstream's `ExactStellarScheme` copies the client's operation with no source of its own, and its
  verify refuses a facilitator operation source in the payload
  (`@x402/stellar` 2.28.0 `exact/facilitator/index.mjs:176,300`).
- What doesn't change: two facilitator signatures (the transaction and the fee bump), the fee
  account paying every fee, channels holding only their reserve, and verify refusing source-account
  auth entries (one would then authorise as the channel).
- Channels already give the facilitator key the medium threshold (`setup.ts:90-92`).

## Implementation

- `exact` calls go out with no operation source; `upto` (0015) keeps a way to give the
  facilitator's consent, chosen in 0015.
- Tests: the built transaction has no operation source; a settlement lands on testnet with the
  fee account's thresholds raised to low 1 / medium 2 / high 2 (the hot key at weight 1).

## Acceptance Criteria

- [ ] Given an `exact` settlement, when the pool builds it, then its `invokeHostFunction` has no operation source
- [ ] Given a fee account whose medium threshold is above the facilitator key's weight, when an `exact` settlement is sent on testnet, then it lands
- [ ] 0048 is told that the fee account no longer needs the medium threshold for `exact`
