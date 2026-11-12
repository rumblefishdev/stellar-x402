---
id: "0105"
title: "Require an API key on pubnet's /verify and /settle"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0007"]
related_tasks: ["0024", "0060", "0077", "0106", "0107"]
tags: [facilitator, security, before-pubnet, priority-high, effort-medium, platform]
links:
  - ../../../docs/adr/0007-fee-abuse-containment.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: the team chose API keys on pubnet over keyless /settle."
---

# Require an API key on pubnet's /verify and /settle

## Summary

On `stellar:pubnet`, `/verify` and `/settle` answer only a caller with a known API key; on
testnet a key is ignored and every route stays open (decided by akot, 2026-11-03, ADR 0007's
amendment of that date). 0024's budgets bound the loss but not availability: self-payments from
free addresses can fill the shared `asset:USDC` budget and refuse every seller's USDC (0024's
[S-design](../archive/0024_FEATURE_spend-budgets-and-breakers/notes/S-design.md), "Residual
risk"). A key costs a Discord account in the Stellar Developers server (0106) and gets a budget of
its own (0107), so that attack no longer reaches the callers with keys. `stellar:pubnet` is refused
until this task and 0107 land, as well as 0090.

## Implementation

- A key registry in PostgreSQL: the SHA-256 hash of each key, never the key; its owner (the
  Discord account from 0106); `active` or `revoked`. One active key per owner.
- The key arrives as `Authorization: Bearer <key>`; upstream's `HTTPFacilitatorClient` sends
  per-route headers through `createAuthHeaders`, so a seller patches nothing.
- Pubnet: `/verify` and `/settle` without a key answer 401 `missing_api_key`, with an unknown or
  revoked one 401 `invalid_api_key`, before any check, and create no counter. `/supported` and
  `/discovery/*` stay open.
- Testnet: the header isn't read at all, not even as a rate-limit key, so testnet answers as it
  does today and the T1 gate's proxy (0028) needs nothing.
- On pubnet the rate limiter keys a caller by its key, not its IP (AD-11).
- The owner travels to the spend policy, which budgets by it (0107).
- If 0077 has landed (one service, the network chosen per request), the rule follows the
  request's network, not `NETWORK`.
- A script for the operator to issue and revoke a key by hand, over the same registry the portal
  writes (0106).
- Docs: the facilitator README ("Callers and rate limits"), AD-11, the threat model.

## Decisions to make here

- Whether a revocation must take effect on the next request across instances, or within a short
  cache time.
- The registry's schema, inside the online-migration rules (0067).

## Acceptance Criteria

- [ ] Given a pubnet request to `/verify` or `/settle` without a key, or with an unknown or revoked
      one, when it arrives, then it gets 401 with nothing verified or settled and no counter made
- [ ] Given a pubnet request with an active key, when the limiter keys it, then it counts under the
      key, and the spend policy gets the key's owner
- [ ] Given a testnet request with or without a key, when it arrives, then it is answered as before
      this task
- [ ] Given the registry, when a key is stored, then only its hash is kept
