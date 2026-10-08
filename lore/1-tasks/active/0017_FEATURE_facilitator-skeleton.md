---
id: "0017"
title: "Facilitator skeleton with store ports, settlement hooks and config"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004"]
related_tasks: ["0012", "0009", "0013"]
tags: [facilitator, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.1 (Platform lane)."
  - date: "2026-10-08"
    status: active
    who: okarcz
    note: >
      Started the day-1 part only: the types-only PR with the four store ports, the settlement
      hook signatures and the zod config schema. The rest of the skeleton goes to the Platform
      lane owner once the types PR is approved.
---

# Facilitator skeleton with store ports, settlement hooks and config

## Status: Active

> Started 2026-10-08 on branch `lore-0017-day1-types`. Scope for now: the day-1 types-only PR
> (first acceptance criterion).

## Summary

As a developer on any of the three lanes, I want a facilitator app that boots, validates its config and wires every part through one composition root, with typed store ports and settlement hooks, so that Payments, Discovery and Platform can build and test their parts in parallel against in-memory fakes.

**Story:** [M1 Story 1.1](../../../docs/planning/m1-epics.md#story-11-facilitator-skeleton-with-store-ports-settlement-hooks-and-config) · **Lane:** Platform · **Covers:** enables FR1–FR21; AD-1, AD-7, NFR7, NFR8

## Context

- `apps/facilitator/src/index.ts` is a placeholder today (`export {};`).
- This story is what lets the three lanes start in parallel: it fixes the seams (ports, hooks, config) on day 1 and the running skeleton by day 3.
- The spine's layout: `http/`, `settlement/`, `ports/`, `adapters/` under `apps/facilitator/src/` (AD-1, AD-7).
- Related tasks: 0009, 0013.

## Implementation

- Day 1: types-only PR with ports, hook signatures and the zod config schema (fee settings, budgets, rate limits, `FACILITATOR_SECRET`, `CHANNELS`, RPC URLs).
- Express 5 app with stub routes; add `zod` to `apps/facilitator`.
- `src/main.ts` composition root that builds the graph from config and picks memory or real stores.
- In-memory fakes for the four ports; one boot-level integration test with `fake-rpc`.
- A small structured logger interface; the backend is chosen in 0014.

## Acceptance Criteria

- [ ] Given a types-only PR with the four store ports (`SettlementStore`, `CatalogStore`, `RateLimitStore`, `SpendStore`) and the operations AD-7 requires, the before-submit and on-success settlement hooks, and the zod config schema, when it is opened on day 1, then all three lanes review and approve it before lane work builds on it
- [ ] Given a valid environment, when the app starts, then it reads and validates config once with zod, listens on the configured port and answers stub routes for `/verify`, `/settle`, `/supported` and `/discovery/resources`; `src/main.ts` is the only composition root and the only place that reads `process.env`
- [ ] Given a missing or invalid config value, when the app starts, then it exits with an error that names the value and never prints a secret
- [ ] Given the test setup, when the integration test boots the app with in-memory fakes of all four ports and `fake-rpc`, then it passes with no network and no database; each port has an in-memory fake in `apps/facilitator`; logs are structured, one event per line, and never contain secrets or full XDR; requests have a body size limit

## Implementation Notes

### Day-1 types PR (branch `lore-0017-day1-types`)

- `apps/facilitator/src/ports/`: `SettlementStore`, `CatalogStore`, `RateLimitStore`,
  `SpendStore`, plus a `Stores` bundle for the composition root.
- `apps/facilitator/src/settlement/hooks.ts`: `SettlementHooks` with `beforeSubmit`, `onFinal`
  and `onSuccess`.
- `apps/facilitator/src/config.ts`: zod env schema, `parseConfig()` into a grouped `Config`, and
  `ConfigError`, which names each bad setting without echoing its value.
- `apps/facilitator/test/config.test.ts`: 7 tests (defaults, fee settings, blank-as-unset, missing
  and invalid values, no secret in errors, the pubnet RPC rule).
- `zod` ^3.25.76 added to `apps/facilitator`.

## Design Decisions

### From Plan

1. **Four ports in `apps/facilitator`** with the operations AD-7 lists: atomic `claim`,
   `findByHash`, forward-only compare-and-set `transition`, catalog `upsert` by key and `list`
   with the AD-20 filters, and fixed-window rate-limit counters.
2. **Upstream types on the wire**: records hold `@x402/core` `PaymentPayload` and
   `PaymentRequirements`; the catalog stores and returns `@x402/extensions` `DiscoveryResource`.

### Emerged (to confirm in the types review)

3. **The channel lease lives on `SettlementStore`**: AD-7 fixes four ports and lists the lease
   among the operations the store must support, so there is no fifth port.
4. **A third hook, `onFinal`**: 0024 must settle or release the spend reservation and feed the
   breakers on every final outcome, not only on `success`.
5. **`onSuccess` is synchronous and returns the `EXTENSION-RESPONSES` value**: AD-8 allows only
   the pure validation before the response, so the hook returns the header value and starts the
   catalog write fire-and-forget. From `resolved` events the value is ignored.
6. **`addHash` is separate from `transition`**: a rebuild adds a hash while the record stays
   `signed`, which a state compare-and-set can't express.
7. **Records keep the payload and requirements**, so a late `success` (startup re-check or
   `resolved` event) can still catalog the resource.
8. **Env names**: `RPC_URLS` (comma-separated, as in the smoke script) replaces
   `STELLAR_RPC_URL`; `STORE` takes only `memory` until 0022.
9. **Interim numeric defaults**, to be confirmed by the owning tasks: `MAX_FEE_STROOPS` 250,000
   (the pool's default), `MIN_VALIDITY_LEDGERS` 12, `SETTLE_TIMEOUT_MS` 30 s, `LEASE_TTL_MS` 30 s,
   body limit 64 KiB, rate limits per minute 120 verify / 60 settle / 120 discovery, a daily spend
   window with 500 XLM global, 5 XLM per payer, 50 XLM per `payTo` and 200 XLM per asset, and a
   breaker after 5 failures with a 10-minute cooldown.
