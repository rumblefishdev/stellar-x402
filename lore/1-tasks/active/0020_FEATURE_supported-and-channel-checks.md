---
id: "0020"
title: "/supported and startup channel checks"
type: FEATURE
status: active
milestone: 1
related_adr: ["0005"]
related_tasks: ["0012", "0017", "0009"]
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
- Update both env examples and `deploy/README.md` for `FACILITATOR_SECRET`.
- From 0009: `keypairSigner(FACILITATOR_SECRET)` is already wired into the pool in `main.ts`, and
  facilitator tests get `FakeRpc` from `@stellar-x402/signer-pool/testing` (0009 decision 27; a
  lint rule keeps it out of `src`). The 0017 question is answered.
- From 0022: both env examples now carry `STORE` and `DATABASE_URL` (pubnet needs
  `STORE=postgres`). They still use `FACILITATOR_SIGNER_SECRETS` and `FEE_BUMP_SIGNER_SECRET`,
  which the config doesn't read; renaming them to `FACILITATOR_SECRET` and `CHANNELS` stays here.

## Acceptance Criteria

- [ ] Given the running facilitator, when `GET /supported` is called, then it lists `exact` on the configured network (`stellar:testnet` in M1) with `extra.areFeesSponsored: true`, the `bazaar` extension, and the facilitator key's address as the only signer; channel addresses never appear, and `upto` is not listed
- [ ] Given `FACILITATOR_SECRET` and `CHANNELS` (addresses only) in config, when the service starts, then it checks every channel with `checkChannel`: master key weight 0 and the facilitator key as the only signer; if any channel fails, the service refuses to start and names the channel
- [ ] Given the deploy env examples, when they are updated, then `deploy/testnet.env.example` and `deploy/mainnet.env.example` use `FACILITATOR_SECRET` and `CHANNELS` instead of `FACILITATOR_SIGNER_SECRETS` and `FEE_BUMP_SIGNER_SECRET`; the facilitator key reaches the pool only as a `TransactionSigner`

## Decisions so far

One row per atomic decision. "From" says who settled it; "vs the task" compares it with the
acceptance criteria above. Code and tests are on PR #51.

| # | What is done | From | vs the task | Who does the same (checked) | Code · test |
| --- | --- | --- | --- | --- | --- |
| 1 | `/supported` answers a plain object built from the config: `exact`, `x402Version: 2`, the configured network, `areFeesSponsored: true`; `extensions: ["bazaar"]`; `signers: {"stellar:*": [facilitator key]}` | grilling | matches AC 1; "on the configured network" replaces "on `stellar:testnet`" | upstream `x402Facilitator.getSupported()` gives the same JSON (test); x402.org's Stellar entry has the same shape, with 2 signers | `http/supported.ts` · `supported.test.ts`, `main.test.ts` "serves /supported" |
| 2 | `maxTimeoutSeconds` is not advertised | grilling | drops 0018's "could" note | spec v2 §7.3 has no such field; x402.org doesn't list it | — |
| 3 | Every channel is checked at once; the startup error names each failing channel with its problem or its read error | grilling | matches AC 2 | — | `settlement/channel-check.ts` · `channel-check.test.ts` |
| 4 | No RPC answers at startup: the service refuses to start | grilling | matches AC 2 and AD-12 | — | `main.ts` · `main.test.ts` "no RPC answers" (reads as `missing` until 0051) |
| 5 | The check runs in `main()` before `compose()`, which gets the same RPC; `compose()` now requires `rpc` | agent | beyond the task | — | `main.ts` · `main.test.ts` |
| 6 | `main()` tests get a JSON-RPC stub over HTTP in `RPC_URLS`; `FakeRpc` is unchanged | agent (plan review) | changes the task's `FakeRpc` note | `fee-agreement.test.ts` stubs the RPC the same way | `test/rpc-stub.ts` |
| 7 | `main()` logs every startup failure with RPC URLs named as their `RPC_URLS` entry; `server.ts` logs only a `ConfigError` | grilling | beyond the task (ADR 0011: no host in logs) | — | `main.ts`, `server.ts` · `main.test.ts` "no RPC answers" |
| 8 | `scripts/verify-smoke.ts` builds the verifier with `buildVerifier`, not `main()` | grilling | beyond the task | `scripts/settle-smoke.ts` runs `main()` on real channels | `scripts/verify-smoke.ts` · manual testnet run |
| 9 | Env examples name `FACILITATOR_SECRET` and `CHANNELS` | task | matches AC 3 | `config.ts` already reads them | `deploy/*.env.example` · none |
| 10 | The startup error keeps each read error's message only, as a plain `Error` | agent | beyond the task | `ConfigError` is a typed error; this one is caught by nobody | `channel-check.ts` |
| 11 | The PostgreSQL pools are created before the check (no connection until the first query) | agent | beyond the task | — | `main.ts` |
| 12 | The facilitator address is derived twice from the secret: for the check and for `/supported` | agent | beyond the task | — | `main.ts` · `main.test.ts` "serves /supported" catches a drift |
| 13 | No startup time limit of its own: about 10 s per RPC URL, from `FallbackRpc` | agent | beyond the task | — | `signer-pool/src/fallback-rpc.ts` |
| 14 | The branch was stacked on PR #41 and moved to `develop` once #41 merged | grilling | beyond the task | — | PR #51 |

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
