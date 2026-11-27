---
id: "0165"
title: "Rust crate: route templates in a listing and a gate that connects on the first request"
type: FEATURE
status: active
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

- [ ] Given a paid route `/assets/{id}/price`, when it answers 402, then the `bazaar` block names
      `/assets/:id/price` and the request's value, and this repository's catalog keys it by the
      template
- [ ] Given a pattern the catalog would drop (a wildcard, a mixed segment), when the route
      answers 402, then the block is as it is today
- [ ] Given a lazy gate, when the seller starts, then the facilitator gets no call; the first
      request reads `/supported` once, and its 402 equals a connected gate's
- [ ] Given a facilitator that fails or doesn't answer, when a request reaches a lazy gate's
      route, then it gets 502 within seconds, the route doesn't run, and a later request is
      served once the facilitator answers
- [ ] `PaymentGate::connect` and every answer of a connected gate are unchanged
