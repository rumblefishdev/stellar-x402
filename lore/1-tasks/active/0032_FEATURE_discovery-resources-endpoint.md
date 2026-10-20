---
id: "0032"
title: "List resources in /discovery/resources"
type: FEATURE
status: active
milestone: 1
related_adr: ["0008"]
related_tasks: ["0012", "0031", "0017", "0028"]
tags: [bazaar, facilitator, priority-high, effort-small, discovery]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 4.3 (Discovery lane)."
  - date: "2026-10-20"
    status: active
    who: akot
    note: "Started by the Discovery lane after PR #30 (0022) merged the durable CatalogStore."
  - date: "2026-10-20"
    status: active
    who: akot
    note: >
      Built: `parseDiscoveryQuery` and the route in `http/discovery.ts`, from a design researched
      two ways (patterns from Google AIP, Microsoft, Zalando, Stripe, Plaid, Berlin Group and other
      x402 facilitators; a prototype with edge-case tests). All 3 acceptance criteria met; 236
      facilitator tests (39 new).
---

# List resources in `/discovery/resources`

## Summary

As a agent, I want to list catalog resources with the standard discovery filters, so that I can find Stellar services with the same client I use for other x402 facilitators.

**Story:** [M1 Story 4.3](../../../docs/planning/m1-epics.md#story-43-list-resources-in-discoveryresources) · **Lane:** Discovery · **Covers:** FR18 (AD-20)

## Context

- Reads `CatalogStore`; builds on the in-memory fake until 0022 lands.
- Search and ranking come in a later tranche.
- The x402 e2e suite checks a facilitator's Bazaar only together with `/discovery/search`, so the gate (0028) runs without `--extensions=bazaar` until search exists; turn it on then.
- Related tasks: 0031, 0017.

## Implementation

- Route in `http/` with filter parsing and the upstream response types.
- Query through `CatalogStore`; tests per filter.
- From 0022 (Karol's review, measured on PostgreSQL 18.3), to verify rather than a decision:
  `CatalogStore.list` filters on narrow columns, but every call still counts and sorts every
  matching `seq` for `total` and the offset: 40–57 ms at 100 000 entries (about 125–145 calls/s
  on a pool of 10), spilling to temp from about 105 000, and about 0.5 s at 1 000 000. Keyset
  paging (`seq > $cursor ORDER BY seq LIMIT n`) is about 0.02 ms at any size; with it, an index on
  `(type, seq)`, and a `total` that is dropped, estimated or cached, since an exact count stays
  O(n). The upstream response's pagination shape decides which.
- From 0022: reject a negative `limit` or `offset` and `\u0000` in the filters before they reach
  `CatalogStore.list`; PostgreSQL rejects a NUL in text, while memory accepts it.

## Acceptance Criteria

- [x] Given cataloged entries, when `GET /discovery/resources` is called, then the response uses the upstream discovery list types, with each resource's `accepts` terms, `extensions.bazaar.info` and `lastUpdated`
- [x] Given the `type`, `payTo`, `network`, `extensions`, `limit` and `offset` filters, when they are used alone or combined, then only matching entries are returned
- [x] Given no `limit`, or a `limit` above the maximum, when the endpoint is called, then the fixed default applies, or the value is clamped to the maximum; results come in a stable order with no ranking

## Result

- `src/http/discovery.ts`: `parseDiscoveryQuery(req.query)`, a zod schema at the HTTP adapter, and
  the `discoveryResources(catalog, logger, metrics)` handler. The store only gets a typed
  `CatalogQuery`. The answer is upstream's `DiscoveryResourcesResponse`:
  `{ x402Version: 2, items, pagination: { limit, offset, total } }`, with the limit actually used.
- `src/http/app.ts` wires it in place of the 501 stub; `AppDeps` gains `metrics`, which `main()`
  now shares with the cataloger.
- `test/discovery.test.ts`: 39 cases. The parser's accepted and refused inputs; the route through
  a running server with a seeded memory catalog (each filter, combined filters, `scheme`, another
  network, stable paging, the total past the end, the clamp, 400s before the store, unknown params
  logged and counted, a store failure, no CORS); and upstream's own `withBazaar` client. Three
  mutants (no `scheme` guard, no clamp, no control-character check) each fail a case.
- `test/main.test.ts` no longer lists `/discovery/resources` among the 501 stubs.

## Design Decisions

### From Plan

1. **Parsing lives at the HTTP adapter and returns a union,** not a throw: `query` (call the
   store), `empty` (a well-formed query nothing can match) or `invalid` with the param's name. A
   throw without `expose` would reach the shared handler as a 500.
2. **`offset` and an exact `total`, as upstream's list contract has them.** Cursors exist only in
   upstream's `/discovery/search`, so the keyset paging noted from 0022 doesn't fit this endpoint,
   and an estimated or cached `total` would break "total count of resources matching". The cost
   is bounded instead: `offset` at most 10 000 (400 beyond, like Elasticsearch's result window),
   `limit` 1 to 100 with a default of 20 (100 is every known x402 facilitator's maximum).
3. **Strict values, clamped size.** `limit`/`offset` must be plain digits (`Number()` reads `""`
   as 0, `0x10` as 16, `1e3` as 1000); a repeated param, a control character such as NUL, an
   empty value, a value over 256 characters or a `network` that isn't CAIP-2 is a 400
   `{ error: "bad_request", param }`, like `/verify`'s body plus the param. A `limit` above 100 is
   clamped and reported, as Google AIP-158 and GitHub do.
4. **Unknown parameters are ignored, logged and counted** (`discovery_unknown_params`, names only,
   capped). Fintech APIs refuse them, but this endpoint implements upstream's contract for
   upstream's client, which would fail every call once upstream adds a filter; the log shows a new
   one first. Chosen by the lane over a 400.
5. **`scheme` is answered from what we settle:** `exact` matches every entry, any other scheme
   none, with no store change. Ignoring it returned `exact` resources for `scheme=upto` in the
   prototype. AD-20 and ADR 0008 are amended; 0015 replaces it once `upto` is cataloged.
6. **A well-formed network we don't serve (e.g. `eip155:8453`) is an empty page,** not a 400, so a
   client asking many facilitators at once gets a page, and `CatalogQuery.network` stays typed.
7. **No try/catch in the route.** Express 5 hands a rejected handler to the shared `onError`,
   which answers 500 and logs it. A 503 with `Retry-After` needs a typed store-unavailable error
   for every route, which stays with 0009's option (the upstream client throws on either status).

### Emerged

8. **`AppDeps` carries `metrics`.** Only the cataloger had counters; the route's counter for
   unknown params needed the same instance, so `main()` builds one and hands it to both.

## Future Work

- If the catalog nears 100 000 entries (0022 measured 40–57 ms per list there, temp from about
  105 000): an index on `(type, seq)` for the type filter, and a cached or bounded count only if
  upstream's contract allows it. Until then the 10 000 offset cap and 0023's rate limit bound it.
- For 0015: a real `scheme` filter once `upto` is cataloged (note added there).
- With 0009's option: a typed store-unavailable error mapped to 503 and `Retry-After` in the
  shared handler, for every route.
