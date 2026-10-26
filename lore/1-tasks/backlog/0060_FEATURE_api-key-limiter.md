---
id: "0060"
title: "Accept a configured API key as the rate limiter's key"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0023"]
tags: [facilitator, security, priority-low, effort-small, platform]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0023: its acceptance criterion 3 moved here."
---

# Accept a configured API key as the rate limiter's key

## Summary

AD-11 and ADR 0007 accept an optional per-caller API key as an alternative to the client IP. 0023
left it out: no key registry exists, and a raw caller-supplied key gives each key its own counter,
which bypasses the limit. Pick this up when a caller needs a budget apart from its IP, such as
sellers sharing one egress IP.

Needed before the public testnet (0026): every seller on Cloudflare Workers reaches a facilitator
behind Cloudflare with the same `CF-Connecting-IP`, `2a06:98c0:3600::103` (Cloudflare's HTTP
request headers reference, cross-zone Worker subrequests), so they all share one budget. Sellers
behind one cloud NAT share theirs the same way.

## Implementation

- `API_KEYS` in the config: SHA-256 hashes of the issued keys, never the keys.
- The key arrives as `Authorization: Bearer <key>`; upstream's `HTTPFacilitatorClient` sends
  per-route headers through `createAuthHeaders`.
- A known key is counted under its own name instead of the IP; an unknown key is a 401
  `invalid_api_key`; no key keeps the IP, so the gate proxy still calls keyless.
- How keys are issued and rotated, in the facilitator README.

## Acceptance Criteria

- [ ] Given a request with a configured API key, when the limiter keys it, then the key is used
      instead of the IP; requests without a key still work
- [ ] Given a request with an unknown API key, when it arrives, then it gets 401 and no counter is
      created
