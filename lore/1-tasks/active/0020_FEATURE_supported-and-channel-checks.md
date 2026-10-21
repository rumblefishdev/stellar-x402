---
id: "0020"
title: "/supported and startup channel checks"
type: FEATURE
status: active
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
  - date: "2026-10-21"
    status: active
    who: karolkow
    note: "Work starts."
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
- From 0022: both env examples now carry `STORE` and `DATABASE_URL` (pubnet needs
  `STORE=postgres`). They still use `FACILITATOR_SIGNER_SECRETS` and `FEE_BUMP_SIGNER_SECRET`,
  which the config doesn't read; renaming them to `FACILITATOR_SECRET` and `CHANNELS` stays here.

## Acceptance Criteria

- [ ] Given the running facilitator, when `GET /supported` is called, then it lists `exact` on the configured network (`stellar:testnet` in M1) with `extra.areFeesSponsored: true`, the `bazaar` extension, and the facilitator key's address as the only signer; channel addresses never appear, and `upto` is not listed
- [ ] Given `FACILITATOR_SECRET` and `CHANNELS` (addresses only) in config, when the service starts, then it checks every channel with `checkChannel`: master key weight 0 and the facilitator key as the only signer; if any channel fails, the service refuses to start and names the channel
- [ ] Given the deploy env examples, when they are updated, then `deploy/testnet.env.example` and `deploy/mainnet.env.example` use `FACILITATOR_SECRET` and `CHANNELS` instead of `FACILITATOR_SIGNER_SECRETS` and `FEE_BUMP_SIGNER_SECRET`; the facilitator key reaches the pool only as a `TransactionSigner`

## Decisions so far

| Situation | What happens | Date |
| --- | --- | --- |
| Base branch | 0020 branches from `lore-0009-settle-exact` (PR #41), whose `compose()` builds the RPC the startup check needs; its PR targets that branch and moves to `develop` once #41 merges | 2026-10-21 |
| No RPC answers at startup | The service refuses to start and logs the RPC error, as for a bad channel (AD-12: it starts only once every channel is checked) | 2026-10-21 |
| Several channels fail the check | All are checked at once; the startup error names each failing channel with its `ChannelProblem` | 2026-10-21 |
| `/supported` response | A plain object from the config, typed `SupportedResponse`: `kinds` = `exact`, `x402Version: 2`, `config.network`, `extra.areFeesSponsored: true`; `extensions` = `["bazaar"]`; `signers` = `{"stellar:*": [facilitator address]}`. A test compares it with upstream `x402Facilitator.getSupported()` for `ExactStellarScheme` plus `BAZAAR` | 2026-10-21 |
| `maxTimeoutSeconds` in `/supported` (0018's note) | Not advertised: spec v2 §7.3 has no such field, and the upstream Stellar server scheme copies only `areFeesSponsored` from `extra` | 2026-10-21 |
| Facilitator tests and the startup check | `FakeRpc.getAccountEntry` (`@stellar-x402/signer-pool/testing`) returns a hardened channel entry instead of throwing | 2026-10-21 |

## Recon (2026-10-21)

- Done by 0009 (PR #41): `keypairSigner(FACILITATOR_SECRET)` feeds the pool, and `FakeRpc` is
  exported from `@stellar-x402/signer-pool/testing`. `FACILITATOR_SECRET`, `CHANNELS` and
  `checkChannel` are already on `develop`. `deploy/README.md` names no key variable, so it needs
  no change.
- Who reads `/supported` (spec v2 §7.3, upstream 2.28.0): `x402Version` per kind is required or
  `HTTPFacilitatorClient` rejects the whole response; the upstream Stellar client throws without
  `extra.areFeesSponsored: true`; only our gate (`conformance/src/gate.ts`) reads `signers`; no
  upstream TS code reads `extensions`.
- The upstream e2e servers fall back to a mock facilitator for any kind we don't list, so a wrong
  `/supported` surfaces later as a client error. The tests assert the whole response.
- x402.org's live `/supported` lists the same Stellar shape, with two signers (its second pays fee
  bumps); ours lists one, since one key does both.
- 0048 changes `checkChannel` itself (hot key below high, a cold recovery signer); the call site
  here stays one line.
- Outside this task: `buildChecks` still hands the raw secret to upstream `createEd25519Signer`
  for `/verify`, which a KMS or Vault signer (0036, 0047) can't provide.

## Not yet decided

- Nothing.

## Out of scope

- The `/verify` path's raw secret (0036, 0047).
- The new signer layout that `checkChannel` will check (0048).
