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
  - date: "2026-10-20"
    status: active
    who: akot
    note: >
      Self-check of PR #50 (security, code review and a PostgreSQL run at 100 000 entries):
      empty values count as absent and `limit=0` gives the total, as upstream's client sends
      them; `list` drops its CTE and gains a `(type, seq)` index (3–10 ms instead of 14–25 ms);
      listings get their own pool. 236 facilitator tests.
  - date: "2026-10-21"
    status: active
    who: akot
    note: >
      Review of PR #50 (Oskar's), after a rebase onto develop with 0009: a misspelled known
      param (`type[]`, `payto`) is a 400 rather than an unfiltered page; a `limit` of any length
      is clamped; the index moves to its own migration, `0003_catalog_type_seq`; tests pin catalog
      writes to the main pool, the empty page off the store and the log cap; a README section.
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
- `src/http/app.ts` wires it in place of the 501 stub; `AppDeps` gains `metrics`, the instance
  `compose()` already shares with the cataloger and the settlement.
- `src/adapters/postgres.ts`: `list` writes its filter out twice instead of sharing a CTE, and runs
  on its own pool (`pools.discovery`, 3 connections, built by `main()`). `postgres-schema.ts`:
  `0003_catalog_type_seq` adds `catalog_type_seq` on `(type, seq)`.
- `test/discovery.test.ts`: 57 cases. The parser's accepted and refused inputs, misspelled names
  among them; the route through a running server with a seeded memory catalog (each filter,
  combined filters, `scheme`, another network, stable paging, the total past the end, the clamp,
  400s before the store, an empty page without the store, unknown params logged, capped and
  counted, a store failure, no CORS); and upstream's own `withBazaar` client. Mutants (no `scheme`
  guard, no clamp, no control-character check; for misspelled names no bracket cut, no trim, no
  lowercase, no exact-name guard, no cap on the echoed name; a nine-digit or unbounded `limit`; no
  log cap on names or their length; the store called for an empty page) each fail a case.
- `test/main.test.ts` no longer lists `/discovery/resources` among the 501 stubs, and
  `test/verify-route.test.ts` and `test/settle-route.test.ts` pass `metrics`.
  `test/postgres.test.ts` counts checkouts per pool, so each store call is pinned to its own (a
  catalog upsert to the main one), and checks that `0003` adds the index to a database past `0002`
  or one that has it; the store contract checks `limit: 0`.
- `apps/facilitator/README.md`: a `/discovery/resources` section for integrators.

## Design Decisions

### From Plan

1. **Parsing lives at the HTTP adapter and returns a union,** not a throw: `query` (call the
   store), `empty` (a well-formed query nothing can match) or `invalid` with the param's name. A
   throw without `expose` would reach the shared handler as a 500.
2. **`offset` and an exact `total`, as upstream's list contract has them.** Cursors exist only in
   upstream's `/discovery/search`, so the keyset paging noted from 0022 doesn't fit this endpoint,
   and an estimated or cached `total` would break "total count of resources matching". The cost
   is bounded instead: `offset` at most 10 000 (400 beyond, like Elasticsearch's result window),
   `limit` 0 to 100 with a default of 20 (100 is every known x402 facilitator's maximum). The
   count, not the offset, is most of a call's cost (decision 9); the cap bounds how far a page
   skips. It also means only the first 10 100 entries of a result can be paged to: the rest are
   reached through a filter, `payTo` above all, and fair ordering is Tranche 2's curation.
3. **Strict values, clamped size.** `limit`/`offset` must be plain digits (`Number()` reads `" "`
   as 0, `0x10` as 16, `1e3` as 1000); a repeated param, a misspelled known param (named as sent),
   a control character such as NUL, a value over 256 characters or a `network` that isn't CAIP-2
   is a 400 `{ error: "bad_request", param }`, like `/verify`'s body plus the param. Misspelled
   means a name that is a known one once brackets are cut, spaces trimmed and case ignored:
   `type[]` (Express 5's parser keeps brackets in the name), `payto`, `Type`, `type `. It would
   otherwise be an unknown param and return the catalog unfiltered (`type[]` found in the
   self-check, both fixed during review). Names are case-sensitive, as in any API, so `payto` is
   refused rather than read as `payTo`. Names further off (`pay_to`, `types`, `foo[]`) stay
   ignored, as decision 4 has it; the cost is that an upstream filter differing from ours only in
   case would be a 400 rather than a logged unknown. A `limit` above 100 is
   clamped and reported, as Google AIP-158 and GitHub do. An empty value counts as absent and
   `limit=0` gives the total alone: upstream's client sends `?type=` for `type: ""`, its type
   allows `limit: 0`, and a 400 would make it throw (changed in the self-check, which first had
   both as a 400).
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
   for every route, which stays with 0019's `StoreUnavailableError` option (the upstream client
   throws on either status).

### Emerged

8. **`AppDeps` carries `metrics`.** The route's counter for unknown params needs the instance
   `compose()` builds for the cataloger and the settlement, so it goes into the `deps` it returns.
9. **`list` without a CTE, and a `(type, seq)` index in `0003_catalog_type_seq`.** 0022's `list` shared its
   filter through a CTE read twice, which PostgreSQL materializes in full: 14–25 ms per call at
   100 000 entries whatever the offset (18.3, p50). Written out twice, the count and the page each
   use an index: 3–10 ms, except a `type` filter, which then scanned the table twice (30 ms for a
   type nothing has). The index answers it in 0.3–3 ms. It first went into `0001_init`, as 0022's
   decision 14 did before any deploy, but `migrate` skips an applied migration by name, and
   databases past `0001` exist since #41 added `0002_success_answered`: they would never get it.
   So it is its own migration, as the schema's header asks, with `IF NOT EXISTS` for a database
   built from this branch (changed in Oskar's review).
10. **Listings run on their own pool.** `/discovery/resources` is public and unauthenticated until
    0023, and ten concurrent callers held all ten main connections (117 calls/s measured), which
    `/settle` needs. Like `reserve` and `hit`, `list` gets three of its own; catalog writes stay
    on the main pool.

## Future Work

- If the catalog grows well past 100 000 entries: the count stays O(matches) (about 25 ms
  unfiltered at 1 000 000 after decision 9), so a cached or bounded count only if upstream's
  contract allows it. Until then the 10 000 offset cap, the listing pool and 0023's rate limit
  bound it.
- For 0015: a real `scheme` filter once `upto` is cataloged (note added there).
- With 0019's `StoreUnavailableError` option: a typed store-unavailable error mapped to 503 and
  `Retry-After` in the shared handler, for every route.
