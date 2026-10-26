---
id: "0023"
title: "Rate limiting and HTTP hardening"
type: FEATURE
status: active
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
  - date: "2026-10-23"
    status: active
    who: karolkow
    note: "Work starts."
---

# Rate limiting and HTTP hardening

## Summary

As a facilitator operator, I want per-route rate limits and basic HTTP hardening, so that one caller can't exhaust the channel pool or the service.

**Story:** [M1 Story 2.2](../../../docs/planning/m1-epics.md#story-22-rate-limiting-and-http-hardening) · **Lane:** Platform · **Covers:** FR12 (AD-11); NFR5

## Context

- From 0053: before the pubnet refusal goes, 0054 decides whether pubnet refuses loopback,
  private and IP resource URLs in the catalog. Done: pubnet refuses them (0054, ADR 0008).
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
  bounds that growth; with `STORE=postgres` (0022) the records survive restarts, so it grows for good until pruned. Also: the `/verify` failover (0045) costs up to
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
- [ ] Given a request with a forged `X-Forwarded-For`, when the limiter keys it, then the client IP comes only from the configured client IP header (`CF-Connecting-IP` behind Cloudflare, decision 3)
- [ ] Given a request with an API key, when the limiter keys it, then the key is used instead of the IP; requests without a key still work, so the gate proxy can call keyless (deferred to 0060, decision 5)
- [ ] Given the HTTP layer, when requests arrive, then bodies over the size limit are refused and `/verify` and `/settle` send no CORS headers
- [ ] Given the facilitator docs, when this story is done, then caller authentication and the rate limits are documented
- [ ] Given the rate-limit store unreachable, when a limited route is called, then it answers 500 and logs the cause (decision 6)
- [ ] Given one client flooding a route, when another client calls it within its budget, then the other client is answered (decision 7)

## Decisions so far

One row per atomic decision, settled before the code. "From" says who settled it; "vs the task"
compares it with the acceptance criteria and the implementation notes above. Each row becomes a
test before its code.

| #   | What is done                                                                                                                                                                                                                                                                                                                                                                                                                           | From                                            | vs the task                                                     | Who does the same (checked)                                                 | Code · test |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| 1 | Separate budgets for `/verify`, `/settle` and `/discovery/*`, one counter per route (key prefixes `verify:`, `settle:`, `discovery:`); over budget is a 429 on that route only. The limiter runs before body parsing, so 400 and 413 answers count. `/discovery` is limited as a prefix, every method and path under it; `/supported` and paths outside the three routes are not limited | task AC 1, agent | matches AC 1 | AD-11 | `http/app.ts`, `http/rate-limit.ts` · `rate-limit.test.ts` "answers 429 … on that route only", "limits /discovery/*" |
| 2 | Defaults 600 `/verify`, 600 `/settle`, 120 `/discovery/*` per 60 s; the config refuses a `/settle` budget below `/verify`'s. The seller's server calls both routes, so a budget per IP is a budget per seller, and `@x402/express` 2.28 settles after the seller's handler ran (`dist/esm/index.mjs:322-374`): a 429 on `/settle` throws away work already done. Fee drain is bounded by the spend budgets (0024), not by this limiter | grilling | changes the defaults (120/60/120) | the gate harness makes one payment per scenario (`conformance/README.md`) | `config.ts` · `config.test.ts` "keeps the /settle budget at or above /verify's", "applies testnet defaults" |
| 3 | The client IP is the `CF-Connecting-IP` header, which Cloudflare sets and refuses from a client (measured through a quick tunnel, cloudflared 2026.10.3: a forged one answers `error code: 1000`). `CLIENT_IP` replaces `TRUSTED_PROXY_HOPS`, is required and takes one of two values: `cloudflare` (that header) or `socket` (the connection's own address, with no proxy in front). Required and closed after review: a free header name let a forgotten setting or another header share one budget or trust a forgeable one. With `cloudflare`, a request without the header, or holding anything but one IP address: 500 and an error log without the value, and no store hit | grilling (the header), agent (the config shape) | changes the implementation note (numeric `trust proxy`, hops 1) | ADR 0011 as revised by 0039 (PR #24); Cloudflare's header docs recommend it | `config.ts`, `http/rate-limit.ts` · `rate-limit.test.ts` "keys the client by CF-Connecting-IP with CLIENT_IP=cloudflare", "ignores X-Forwarded-For", "answers 500 … header is missing", "answers 500 without a store hit when the header holds anything but one address"; `config.test.ts` "requires CLIENT_IP …", "refuses a leftover TRUSTED_PROXY_HOPS" |
| 4 | IPv6 addresses are counted per /56 (`ipKeyGenerator`, the library default), so one /64 can't rotate past the limit | agent | beyond it | express-rate-limit 8 default | `http/rate-limit.ts` · `rate-limit.test.ts` "counts IPv6 clients per /56" |
| 5 | No API key in this task: no key registry exists, and a raw caller key gives each key its own counter, which bypasses the limit. AC 3 moves to 0060 | grilling | changes AC 3 | AD-11 and ADR 0007: optional, not required in Tranche 1 | — · — |
| 6 | Store unreachable: the request fails with 500 `internal_error` and the cause is logged: the middleware's rejection reaches `onError`. `/settle` fails without the database anyway | grilling | decides the open option |  | `http/rate-limit.ts` (Express answers the rejection) · `rate-limit.test.ts` "answers 500 and logs the cause when the store fails" |
| 7 | In front of the store, the process remembers a key over its budget until its window ends and answers 429 without a database hit, so one client's flood can't hold the 3-connection `hit` pool | grilling (devil's advocate review) | decides the open option |  | `http/rate-limit.ts` · `rate-limit.test.ts` "answers a client over budget from memory" |
| 8 | Our own middleware of about 40 lines, with only `ipKeyGenerator` from `express-rate-limit` 8.7.0 (already in the lockfile through `@modelcontextprotocol/sdk`). The library's middleware needed an adapter onto `RateLimitStore` with `decrement` and `resetKey` that throw, one instance per limiter (`ERR_ERL_STORE_REUSE`), its headers off and its logger rerouted: more code than the counting it would replace | agent | matches "one middleware" | MCP SDK uses the same library | `http/rate-limit.ts` · all of `rate-limit.test.ts` |
| 9 | A 429 answers `{"error":"too_many_requests"}` with `Retry-After`; no `X-RateLimit-*` or `RateLimit-*` headers. Upstream's client throws on a non-200 `/verify` or `/settle` and honours `Retry-After` only on `/supported` | agent | beyond it |  | `http/rate-limit.ts` · `rate-limit.test.ts` "answers 429 with Retry-After …" |
| 10 | A NUL (`\u0000`) or a lone surrogate in any string or key of a `/verify` or `/settle` body is a 400, checked in `parsePaymentRequest` | task | matches the implementation note |  | `http/app.ts` · `verify-route.test.ts`, `settle-route.test.ts` "answers 400 for a NUL or a lone surrogate …" |
| 11 | No CORS on any route, as today; a test pins that `/verify` and `/settle` send no CORS headers | task AC 4 | matches AC 4 |  | — · `verify-route.test.ts`, `settle-route.test.ts` "sends no CORS headers" |
| 12 | The pubnet refusal names what is still missing: spend budgets (0024), the channel lease (0025) and store pruning (0050) | grilling | adds 0050 |  | `config.ts` · `config.test.ts`, `main.test.ts` pubnet refusal |
| 13 | The facilitator README documents caller authentication (none, every route is keyless) and the limits | task AC 5 | matches AC 5 |  | `README.md` "Callers and rate limits" · — |

Decision 7, measured on a local PostgreSQL 14 with the `hit` pool of 3: one client sends a burst
over 100 connections against a budget of 10, while 10 other clients each send one request on their
own connections.

| Burst  | With the in-process filter       | Without it                          |
| ------ | -------------------------------- | ----------------------------------- |
| 2 000  | 25 store hits, others ≤ 267 ms   | 2 010 store hits, others ≤ 110 ms   |
| 20 000 | 34 store hits, others ≤ 312 ms   | 20 010 store hits, others ≤ 114 ms  |

No errors either way: a local database keeps up with one write per request, so the filter isn't
needed to keep other clients answered here. It takes a flood's writes off the database (about
600 times fewer), which shares its server with the settlements. The other clients' time is the
event loop answering the burst, not the store.

## Not yet decided

Nothing.

## Out of scope

- API keys as a limiter key: 0060.
- Pruning `rate_limits` rows: 0050.
- Payer, recipient and asset budgets: 0024.
- Edge rate limiting at Cloudflare: 0038.
