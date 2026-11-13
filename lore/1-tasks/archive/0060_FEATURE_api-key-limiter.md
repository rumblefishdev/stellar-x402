---
id: "0060"
title: "Accept a configured API key as the rate limiter's key"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0007"]
related_tasks: ["0023", "0024", "0026", "0105"]
tags: [facilitator, security, priority-low, effort-small, platform]
links:
  - ../../../docs/architecture/m1-spine.md
  - ../../../apps/facilitator/README.md
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0023: its acceptance criterion 3 moved here."
  - date: "2026-11-12"
    status: active
    who: akot
    note: "Work starts."
  - date: "2026-11-13"
    status: completed
    who: akot
    note: >
      #179 merged (7167414c): the shared rate-limit budget is accepted on testnet; the
      facilitator README, FR12 and Story 2.2 in the M1 epics, and 0026 say so. Docs only, no
      code. The API key criteria went to 0105, for pubnet.
---

# Accept a configured API key as the rate limiter's key

## Summary

0023 left the API key out of the rate limiter and moved its criterion here. Since then the key
went to pubnet (0105) and testnet ignores one, so one question was left for this task: on testnet,
do sellers that share an address get budgets of their own? Decided: no, the shared budget is
accepted there (akot, 2026-11-12). Nothing changes in the code.

## Context

- The limiter counts a client by its IP (`CF-Connecting-IP`, AD-11): by default 600 `/verify` and
  600 `/settle` requests a minute.
- Every seller on Cloudflare Workers reaches a facilitator behind Cloudflare with the same
  `CF-Connecting-IP`, `2a06:98c0:3600::103` (Cloudflare's
  [HTTP headers reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
  cross-zone Worker subrequests), so they all share one budget. Sellers behind one cloud NAT share
  theirs the same way.
- One seller that uses the budget up gets the others a 429 until the window ends. On `/settle`
  that comes after the seller served its buyer.
- Pubnet is not affected. There `/verify` and `/settle` require a key from our portal and the
  limiter counts a caller by it (0024 decision 31, ADR 0007's amendment of 2026-11-03;
  [0105](../backlog/0105_FEATURE_api-keys-on-pubnet.md),
  [0106](../backlog/0106_FEATURE_api-key-portal-discord.md)), with a fee budget of its own
  ([0107](../backlog/0107_FEATURE_per-key-fee-quota.md)).

## Design Decisions

### From Plan

1. **The key is 0105's, not this task's** (akot, 2026-11-03). The plan this task was spawned with
   is dropped here: `API_KEYS` hashes in the config, a known key counted in place of the IP, a 401
   for an unknown one. 0105 builds it for pubnet over a registry.
2. **The shared budget is accepted on testnet** (akot, 2026-11-12). Testnet moves no real money:
   the cost is a test payment refused with a 429. `RATE_LIMIT_VERIFY` and `RATE_LIMIT_SETTLE`
   raise the budget for every client if testnet's sellers meet it.

### Considered and not taken

- **Count a Worker by `CF-Worker`**, the zone that owns it, which Cloudflare adds to every Worker
  `fetch()`, under a cap for the Workers address as a whole. Not measured: Cloudflare's reference
  does not say what the header holds for a Worker on `workers.dev`, nor whether a Worker can
  overwrite it. If it can, a
  [Transform Rule](https://developers.cloudflare.com/rules/transform/examples/add-request-header-subrequest-other-zone/)
  in our zone could copy `cf.worker.upstream_zone` into a header of ours; not checked either. It
  does nothing for a NAT.
- **A higher budget for named addresses**, in the config: fewer collisions, but one seller still
  uses up the others' budget.
- **A key on testnet, issued by hand**, this task's first plan. The only one that also covers a
  NAT, but it reverses "testnet ignores a key" (AD-11, ADR 0007, 0105's third criterion).
- **Count by `payTo`.** The limiter runs before the body is parsed (0023 decision 1), and `payTo`
  is the caller's text, so each new one would get a fresh counter.

## Implementation Notes

Docs only: the facilitator README ("Sellers on Cloudflare Workers share one budget"), FR12 and
Story 2.2 in `docs/planning/m1-epics.md`, and a line in 0026.

## Acceptance Criteria

- [ ] Given a request with a configured API key, when the limiter keys it, then the key is used
      instead of the IP; requests without a key still work (moved to 0105, for pubnet; on testnet
      a key is ignored)
- [ ] Given a request with an unknown API key, when it arrives, then it gets 401 and no counter is
      created (moved to 0105, its first criterion)
- [x] Given sellers that share one address on testnet, when this task ends, then whether they
      share one budget is decided and the README, the M1 epics and 0026 say so
