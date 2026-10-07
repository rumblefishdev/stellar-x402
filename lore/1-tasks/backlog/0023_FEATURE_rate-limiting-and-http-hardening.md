---
id: "0023"
title: "Rate limiting and HTTP hardening"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0012", "0017"]
tags: [facilitator, security, priority-high, effort-small, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.2 (Platform lane)."
---

# Rate limiting and HTTP hardening

## Summary

As a facilitator operator, I want per-route rate limits and basic HTTP hardening, so that one caller can't exhaust the channel pool or the service.

**Story:** [M1 Story 2.2](../../../docs/planning/m1-epics.md#story-22-rate-limiting-and-http-hardening) · **Lane:** Platform · **Covers:** FR12 (AD-11); NFR5

## Context

- Payer, recipient and asset limits are spend budgets (0024), not this limiter's job.
- Numeric limits are set in config and recorded in this task when chosen.
- Related tasks: 0017.

## Implementation

- One rate-limit middleware with per-route budgets, keyed by trusted-proxy IP or API key.
- Body size limit and CORS policy in `http/`.
- A short doc on caller authentication and limits.

## Acceptance Criteria

- [ ] Given separate budgets for `/verify`, `/settle` and `/discovery/*`, when a client exceeds one, then it gets HTTP 429 on that route only; counters go through `RateLimitStore`
- [ ] Given a request with a forged `X-Forwarded-For`, when the limiter keys it, then the client IP comes only from the configured trusted proxy hops
- [ ] Given a request with an API key, when the limiter keys it, then the key is used instead of the IP; requests without a key still work, so the gate proxy can call keyless
- [ ] Given the HTTP layer, when requests arrive, then bodies over the size limit are refused and `/verify` and `/settle` send no CORS headers
- [ ] Given the facilitator docs, when this story is done, then caller authentication and the rate limits are documented
