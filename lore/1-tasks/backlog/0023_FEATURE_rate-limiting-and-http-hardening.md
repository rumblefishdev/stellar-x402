---
id: "0023"
title: "Rate limiting and HTTP hardening"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007", "0011"]
related_tasks: ["0012", "0017", "0014", "0009", "0022"]
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
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): behind the ALB, `TRUSTED_PROXY_HOPS` is 1.
  - Implement it as Express's numeric `trust proxy` (`app.set("trust proxy", hops)`): 1 takes the
    rightmost `X-Forwarded-For` entry, and 0 the socket address.
  - Test both.
- Option from 0022's third review, to verify rather than a decision (a better approach may exist): key the limiter on an API key only after validating it. A raw caller-supplied key
  creates a new counter per request, which bypasses the limit and grows `rate_limits` without
  bound. A key over about 2.7 KB also makes the primary-key insert fail (btree row size), so the
  middleware either lets the request through or answers 500. Options: hash the key in the adapter,
  or document a maximum length in the port. Also consider an in-process pre-filter before the
  database `hit`, and decide what the limiter does when the store is unreachable (let requests
  through or refuse them). `hit` runs on its own pool of 3 (0022 decision 16) without a
  `lock_timeout`, so past that pool a flood waits up to 5 s for a connection and then rejects.
- From 0009 (PR #41 review): without a rate limit, `/settle` self-payments that end before
  signing (`no_channel_in_time`, `…_timeout`) cost nothing on chain, and each keeps a record with
  its full payload in `MemorySettlementStore` (about 16k per GB). The `/settle` budget per IP
  bounds that growth until 0022's durable store. Also: the `/verify` failover (0045) costs up to
  10 s per RPC URL per request when the URLs hang, so the `/verify` budget should count requests,
  not just successes.
- From 0009 (PR #41 reviews), moved here when 0022 closed before PR #41 merged: reject a NUL
  (`\u0000`) and lone UTF-16 surrogates (`isWellFormed()`) in `/verify` and `/settle` bodies and
  in resources. PostgreSQL refuses a NUL in `text` and `jsonb`, `jsonb` refuses a lone surrogate
  and `text` turns it into U+FFFD. Today a NUL fails the claim as a store error, a 500 before money
  moves.
- From 0009 (PR #41, decision 49): the config refuses `NETWORK=stellar:pubnet` until spend
  budgets (0024), rate limits (0023) and the channel lease (0025) land: the rule after the
  `STORE` one in `config.ts`, with tests in `config.test.ts` and `main.test.ts`. Whichever of the
  three lands last removes it; an earlier one narrows its message to what is still missing,
  together with the facilitator README.

## Acceptance Criteria

- [ ] Given separate budgets for `/verify`, `/settle` and `/discovery/*`, when a client exceeds one, then it gets HTTP 429 on that route only; counters go through `RateLimitStore`
- [ ] Given a request with a forged `X-Forwarded-For`, when the limiter keys it, then the client IP comes only from the configured trusted proxy hops
- [ ] Given a request with an API key, when the limiter keys it, then the key is used instead of the IP; requests without a key still work, so the gate proxy can call keyless
- [ ] Given the HTTP layer, when requests arrive, then bodies over the size limit are refused and `/verify` and `/settle` send no CORS headers
- [ ] Given the facilitator docs, when this story is done, then caller authentication and the rate limits are documented
