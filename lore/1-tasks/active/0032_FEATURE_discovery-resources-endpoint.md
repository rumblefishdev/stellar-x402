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
  - date: "2026-10-21"
    status: active
    who: akot
    note: >
      Self-review with GSD's code reviewer, measured on PostgreSQL 18.3 at 100 000 entries: the
      network we serve no longer filters and another Stellar network skips the store (29 ms to
      8 ms); the offset cap goes from 10 000 to 1 000 000, so every entry can be paged to; a
      `payTo` filter needs no index of its own. 389 facilitator tests.
  - date: "2026-10-26"
    status: active
    who: akot
    note: >
      Karol's review of PR #50, after merging develop (`/supported` from 0020, 0053): the discovery
      test passes `supported`, so `pnpm typecheck` is clean; `extensions=bazaar` filters nothing
      and another extension skips the store, like `network`; the listings' pool cuts a statement
      off at 2 s; ADR 0012 counts the fourth pool; `limit`'s bounds cite spec v2 §8.1; the 0015
      note says `text[]` with a GIN index and a backfill.
---

# List resources in `/discovery/resources`

## Summary

As a agent, I want to list catalog resources with the standard discovery filters, so that I can find Stellar services with the same client I use for other x402 facilitators.

**Story:** [M1 Story 4.3](../../../docs/planning/m1-epics.md#story-43-list-resources-in-discoveryresources) · **Lane:** Discovery · **Covers:** FR18 (AD-20)

## Context

- Reads `CatalogStore`; builds on the in-memory fake until 0022 lands.
- Search and ranking come in a later tranche.
- The x402 e2e suite checks a facilitator's Bazaar only together with `/discovery/search`, so the gate (0028) runs without `--extensions=bazaar` until search exists; turn it on then.
- That check can't pass against our catalog as it is (local gate run, 2026-10-22). It expects
  `/discovery/resources` to list `http://localhost:<port>/…` for the HTTP servers and
  `mcp://tool/<name>` for the MCP one (upstream `e2e/extensions/bazaar.ts:146-152` at `10b2d06`).
  Our validator refuses http, loopback hosts (ADR 0008) and any non-web scheme, so every one of
  the 18 settlements logged `catalog_rejected`. 16 of them failed even earlier, on
  `resource.mimeType`: upstream's server sends `mimeType: ""` when a route sets none
  (`@x402/core` 2.28.0, `routeConfig.mimeType || ""`). Both are fixed by 0053.
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
  the `discoveryResources(catalog, logger, metrics, network)` handler, with the network it serves. The store only gets a typed
  `CatalogQuery`. The answer is upstream's `DiscoveryResourcesResponse`:
  `{ x402Version: 2, items, pagination: { limit, offset, total } }`, with the limit actually used.
- `src/http/app.ts` wires it in place of the 501 stub; `AppDeps` gains `metrics`, the instance
  `compose()` already shares with the cataloger and the settlement.
- `src/adapters/postgres.ts`: `list` writes its filter out twice instead of sharing a CTE, and runs
  on its own pool (`pools.discovery`, 3 connections and a 2 s statement timeout, built by
  `main()`; `createPool` takes the timeout). `postgres-schema.ts`:
  `0003_catalog_type_seq` adds `catalog_type_seq` on `(type, seq)`.
- `test/discovery.test.ts`: 64 cases. The parser's accepted and refused inputs, misspelled names
  among them; the route through a running server with a seeded memory catalog (each filter,
  combined filters, `scheme`, another network, another extension, stable paging, the total past the end, the clamp,
  400s before the store, an empty page without the store, unknown params logged, capped and
  counted, a store failure, no CORS); and upstream's own `withBazaar` client. Mutants (no `scheme`
  guard, no clamp, no control-character check; for misspelled names no bracket cut, no trim, no
  lowercase, no exact-name guard, no cap on the echoed name; a nine-digit or unbounded `limit`; no
  log cap on names or their length; the store called for an empty page; the served network passed
  on, another Stellar network sent to the store, the old offset cap; `extensions=bazaar` passed
  on, another extension sent to the store) each fail a case.
- `test/main.test.ts` checks an unknown route's 404 instead of the 501 stubs, none of which is
  left, and
  `test/verify-route.test.ts` and `test/settle-route.test.ts` pass `metrics`.
  `test/postgres.test.ts` counts checkouts per pool, so each store call is pinned to its own (a
  catalog upsert to the main one) and the listings' pool alone to a 2 s statement timeout, and
  checks that `0003` adds the index to a database past `0002` or one that has it; the store
  contract checks `limit: 0`.
- `apps/facilitator/README.md`: a `/discovery/resources` section for integrators.

## Design Decisions

### From Plan

1. **Parsing lives at the HTTP adapter and returns a union,** not a throw: `query` (call the
   store), `empty` (a well-formed query nothing can match) or `invalid` with the param's name. A
   throw without `expose` would reach the shared handler as a 500.
2. **`offset` and an exact `total`, as upstream's list contract has them.** Cursors exist only in
   upstream's `/discovery/search`, so the keyset paging noted from 0022 doesn't fit this endpoint,
   and an estimated or cached `total` would break "total count of resources matching". `limit`
   is 0 to 100 with a default of 20, from x402 spec v2 §8.1 (default 20, range 1–100); a larger
   one, which some facilitators allow, is clamped. `offset` is at most 1 000 000 (400 beyond), so
   every entry can be paged to: the count, not the offset, is most of a call's cost (decision 9),
   and a deep page costs little more (15 ms at offset 99 000 of 100 000 entries, 9 ms at 0). The
   cap was first 10 000, like Elasticsearch's result window, which left every match past the
   first 10 100 out of reach, the newest first: no filter narrows a catalog the caller doesn't
   know yet (`type` has two values, a database one network, and `payTo` must be known
   beforehand). Raised in the GSD self-review. Fair ordering is Tranche 2's curation.
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
6. **`network` is answered from the one we serve.** Another well-formed network (`eip155:8453`,
   or the other Stellar network) is an empty page without the store, not a 400, so a client
   asking many facilitators at once gets a page. Ours filters nothing and isn't passed on: the
   catalog holds only its own network (ADR 0012; `/settle` refuses any other), and a filter every
   entry matches made the count slower than none (29 ms against 8 ms at 100 000 entries).
   `CatalogQuery.network` stays in the port, typed. Changed in the GSD self-review.
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
   built from this branch (changed in Oskar's review). A `payTo` filter needs no index of its
   own: PostgreSQL 18 answers it from the primary key, where `pay_to` comes second (1.3 ms for a
   seller of 40 entries, 3.5 ms for one of 20 000). `(pay_to, seq)` gained under a millisecond,
   and nothing on a table not yet vacuumed.
10. **Listings run on their own pool.** `/discovery/resources` is public and unauthenticated until
    0023, and ten concurrent callers held all ten main connections (117 calls/s measured), which
    `/settle` needs. Like `reserve` and `hit`, `list` gets three of its own; catalog writes stay
    on the main pool. ADR 0012 counts it: 19 connections per process. Until 0023, three slow
    listings hold the whole pool, and from 20 clients 50–90% of requests got a 500 (Karol's
    review, 1 000 000 entries, PostgreSQL 17); the pool's statement timeout is 2 s instead of
    10 s, well above the slowest listing measured (~0.5 s), so a stuck one frees it sooner.
11. **`extensions` filters like `network`.** The validator, the only way into the catalog, writes
    `extensions.bazaar` and drops every other key (pinned in `packages/bazaar`), so
    `extensions=bazaar` matches every entry and is not passed on, and any other key is an empty
    page that never reaches the store. As a filter, `bazaar` made PostgreSQL scan the table: 82 ms
    at 100 000 entries against 8 ms unfiltered, and up to 461 ms at 1 000 000, 364 ms for an
    unknown key (Karol's review). `CatalogQuery.extensions` stays for when a second extension is
    cataloged.

## Future Work

- If the catalog grows well past 100 000 entries: the count stays O(matches) (about 25 ms
  unfiltered at 1 000 000 after decision 9), so a cached or bounded count only if upstream's
  contract allows it. Until then the listing pool and 0023's rate limit bound it.
- Once a second extension is cataloged, `extensions` filters again (decision 11); a GIN index
  counts no row on its own, so a common key would need its own partial index on `seq`.
- A page of 100 entries at the 32 KiB extension cap is 3.2 MB and about 40 ms of Node CPU per
  call, 22 ms of it in `list` (measured). Each such entry takes a paid settlement, but listing
  them is free, so 0023's limit for this route should allow for it.
- For 0015: a real `scheme` filter once `upto` is cataloged (note added there).
- With 0019's `StoreUnavailableError` option: a typed store-unavailable error mapped to 503 and
  `Retry-After` in the shared handler, for every route.
