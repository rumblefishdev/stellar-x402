---
id: "0165"
title: "Rust crate: route templates in a listing and a gate that connects on the first request"
type: FEATURE
status: completed
owner: akot
milestone: 2
related_adr: []
related_tasks: ["0041", "0136", "0140"]
tags: [sdk, rust, seller, bazaar, priority-high, effort-small]
links: []
history:
  - date: "2026-11-27"
    status: active
    who: akot
    note: >
      Spawned from 0041 and started: its two sellers (Prices API, SorobanScan) are Lambdas with
      path parameters in their paid routes, and the crate serves neither yet. The route template
      is 0140's item, done now.
  - date: "2026-11-27"
    status: completed
    who: akot
    note: >
      PR #276 merged (ff5933c2): the crate names a route's template in its 402 and has
      `PaymentGate::lazy`. 117 tests with the layer (+9), 68 without (+1), one new test in
      `packages/bazaar`; an unpaid run against the testnet facilitator. 0041's sellers pin
      ff5933c2b8648b327fe09f7c0369df88efea37d3. Three decisions emerged, none spawned a task.
---

# Rust crate: route templates in a listing and a gate that connects on the first request

## Summary

As a seller on AWS Lambda with routes such as `/assets/{id}/price`, I want the crate to list such
a route once, by its template, and to ask the facilitator on the first request instead of at
start, so that the catalog doesn't fill with one listing per asset and a cold start doesn't wait
for the facilitator.

## Context

- 0041's design and plan: `lore/1-tasks/active/0041_FEATURE_example-integrations/notes/` on the
  branch `lore-0041-example-integrations` (decisions 8 and 11, plan Tasks 1 and 2).
- The catalog already keys a listing by its `routeTemplate` (`packages/bazaar/src/url.ts`,
  `matchRouteTemplate`); the crate never sends one.
- `PaymentGate::connect` reads `/supported` at start. A Lambda would pay that on every cold
  start, and one started while the facilitator restarts would have no paid routes for its life.
- The crate's answers stay equal to `@x402/express` 2.31.0's (0136 decision 23).

## Implementation Plan

- A 402 of a route with a path parameter carries `routeTemplate` and `info.input.pathParams`, as
  `@x402/extensions` 2.31.0's `bazaarResourceServerExtension` writes them, read from axum's
  `MatchedPath`; a pattern the catalog would drop gets no template.
- `PaymentGate::lazy`: no call at start; the first request reads `/supported`, a success is kept,
  a failure answers 502 and is asked again on the next request.

## Acceptance Criteria

- [x] Given a paid route `/assets/{id}/price`, when it answers 402, then the `bazaar` block names
      `/assets/:id/price` and the request's value, and this repository's catalog keys it by the
      template
- [x] Given a pattern the catalog would drop (a wildcard, a mixed segment), when the route
      answers 402, then the block is as it is today
- [x] Given a lazy gate, when the seller starts, then the facilitator gets no call; the first
      request reads `/supported` once, and its 402 equals a connected gate's
- [x] Given a facilitator that fails or doesn't answer, when a request reaches a lazy gate's
      route, then it gets 502 within seconds, the route doesn't run, and a later request is
      served once the facilitator answers
- [x] `PaymentGate::connect` and every answer of a connected gate are unchanged

## Implementation Notes

- `src/bazaar.rs`: `template(pattern, path)` turns axum's pattern into the template and the
  parameters, by the catalog's own rules; `Listing::extension` adds them to the block.
- `src/axum.rs`: `PaidRoute::required` reads `MatchedPath`; the gate keeps `/supported` in an
  `Arc<OnceLock<Supported>>`, filled by `connect` or by the first request of `lazy`; a route keeps
  its terms as `charge` built them and each request completes them.
- `tests/fixtures/bazaar-route-template.json` is the output of `@x402/extensions` 2.31.0's
  `declareDiscoveryExtension` and `bazaarResourceServerExtension.enrichDeclaration` for the test
  seller's listing, not written by hand. The crate's test and `packages/bazaar`'s read the same
  file.

## Design Decisions

### From Plan

1. **The template is read from axum's `MatchedPath`**, so no seller code changes, and a pattern
   the catalog would drop gets no template.
2. **A lazy gate reads on the first request, keeps a success, forgets a failure**, as
   `prepareHttpServer` does upstream. The read is given at most 5 s.

### Emerged

3. **No `Listing::path_schema`.** The plan had it. Without it the block says
   `pathParams: {"type": "object"}`, which is what upstream writes by default and the catalog
   takes; the request's own value is the example. Add it when a seller asks.
4. **No public `with_route_listing`.** The plan had it. Only the axum layer knows a pattern, so
   it is `pub(crate)` (`PaymentRequired::listed`); a seller without axum has `with_listing`.
5. **A failed first read answers what upstream answers, not 502 for everything.** The plan said
   502 with a message in every case. `@x402/express` 2.31.0 answers 502 with the message only for
   a `FacilitatorResponseError` (late, or not readable) and 500 `Internal Server Error` for the
   rest, a network the facilitator does not settle included. The crate's rule is to answer as
   upstream (0136 decision 23), so it does; the cause goes to `on_event`.
6. **A failed read is not remembered.** Every request during an outage waits up to 5 s for
   `/supported`. A seller's own request limit bounds that; marked `shortcut:` in the code.
