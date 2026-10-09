---
id: "0020"
title: "/supported and startup channel checks"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0005"]
related_tasks: ["0012", "0017"]
tags: [facilitator, configuration, priority-high, effort-small, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.6 (Platform lane)."
---

# `/supported` and startup channel checks

## Summary

As a resource server, and as the operator, I want `GET /supported` to describe exactly what the facilitator does, and the service to refuse channels another key could move, so that clients aren't misled and our channel accounts stay under the facilitator key's sole control.

**Story:** [M1 Story 1.6](../../../docs/planning/m1-epics.md#story-16-supported-and-startup-channel-checks) · **Lane:** Platform · **Covers:** FR3 (AD-12, AD-13); NFR4

## Context

- Independent of `/settle`, so Platform can build it right after the skeleton.
- ADR 0005 records why channels count as the facilitator and why only the facilitator key is advertised.
- Related tasks: 0017.

## Implementation

- `/supported` route with `@x402/core` v2 types.
- Startup check using signer-pool's `checkChannel` for every configured channel.
- `keypairSigner` adapter for `FACILITATOR_SECRET`; update both env examples and `deploy/README.md`.
- From 0017: decide with 0009 how facilitator tests get `FakeRpc` (it sits in
  `packages/signer-pool/test/` and isn't exported; a `./testing` subpath export is the
  suggestion). The 0017 boot test runs without one, since nothing in its graph calls RPC.

## Acceptance Criteria

- [ ] Given the running facilitator, when `GET /supported` is called, then it lists `exact` on `stellar:testnet` with `extra.areFeesSponsored: true`, the `bazaar` extension, and the facilitator key's address as the only signer; channel addresses never appear, and `upto` is not listed
- [ ] Given `FACILITATOR_SECRET` and `CHANNELS` (addresses only) in config, when the service starts, then it checks every channel with `checkChannel`: master key weight 0 and the facilitator key as the only signer; if any channel fails, the service refuses to start and names the channel
- [ ] Given the deploy env examples, when they are updated, then `deploy/testnet.env.example` and `deploy/mainnet.env.example` use `FACILITATOR_SECRET` and `CHANNELS` instead of `FACILITATOR_SIGNER_SECRETS` and `FEE_BUMP_SIGNER_SECRET`; the facilitator key reaches the pool only as a `TransactionSigner`
