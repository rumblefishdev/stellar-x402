---
id: "0141"
title: "Raise the @x402 packages from 2.28.0 to 2.31.0 across the repo"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0136", "0140", "0130"]
tags: [upstream, dependencies, facilitator, priority-medium, effort-medium]
links: []
history:
  - date: "2026-11-13"
    status: backlog
    who: akot
    note: >
      Spawned from 0136's parity work: the Rust crate answers as @x402/express 2.31.0, the newest
      upstream, while the repo's TypeScript is on 2.28.0. A task of its own, as it touches the
      facilitator in production (akot, 2026-11-13).
---

# Raise the @x402 packages from 2.28.0 to 2.31.0 across the repo

## Summary

As the team, we want our TypeScript on the newest `@x402` packages, 2.31.0, so the facilitator,
the TypeScript examples and the Rust crate follow the same upstream.

## Context

- Every package that uses upstream pins `~2.28.0` (2026-09-29): `apps/facilitator`,
  `apps/mcp-local` and its `e2e`, `examples/http-api`, `examples/mcp-metered` (`@x402/mcp`),
  `packages/bazaar`, `packages/mcp`, `packages/signer-pool`. Since then 2.29.0 (2026-10-28),
  2.30.0 (2026-11-04) and 2.31.0 (2026-11-12) came out.
- 0136 holds the Rust crate equal to `@x402/express` 2.31.0 (its decision 23), checked against a
  scratch copy of `examples/http-api` on 2.31.0. Until this task, our own twin answers otherwise in
  the places listed below.
- `@x402/express` 2.31.0 needs `express` `^5.3.0` as a peer; the repo has 5.2.1.

What changed between 2.28.0 and 2.31.0, read from the built packages (no changelog ships):

- `@x402/core`, the seller's side: a 402 with an `error` repeats it in the body (`{error}` in
  place of `{}`); HEAD matches a GET route, and `*` no longer matches OPTIONS; the facilitator
  client reads at most 1 MiB of an answer (`http response body too large: limit 1048576 bytes`);
  `PAYMENT-SIGNATURE` must decode to a JSON object; a failing `beforeVerify` or `beforeSettle` hook
  now refuses the payment; an `afterSettle` hook can abort (`AfterSettleAbortError`); a settlement
  override above the authorized amount is refused (`upto`); a CAIP-2 network must match
  `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`; `accepts` holds at most 1024 terms.
- `@x402/core` facilitator code (193 changed lines) and `@x402/stellar` (108 in its index, 18 in
  the exact facilitator, 102 in the exact client): not read yet. Our facilitator verifies and
  settles with them, so they decide what this task tests.
- `@x402/express`: an unexpected settle error answers `{"error": "settlement_failed"}`; text
  bodies for custom 402s.
- `@x402/extensions` (bazaar): the declared method is one the input can take (GET for a query,
  POST for a body); the discovery client reads at most 4 MiB.
- `@x402/fetch`: a 402's body is read up to 1 MiB (`ResponseBodyTooLargeError`).

## Implementation Plan

- Read the facilitator-side diffs (`@x402/core` facilitator, `@x402/stellar`) against
  `apps/facilitator`'s verify and settle, and 0130's upstream fix.
- Raise every `@x402/*` to 2.31.0 and `express` to `^5.3.0`; run the tests, the MCP e2e run and a
  paid testnet request through the facilitator.
- Re-capture any fixture taken from 2.28.0 output that changes.

## Acceptance Criteria

- [ ] Every package in the repo is on `@x402` 2.31.0, and `pnpm test` passes
- [ ] Given a payment from `@x402/fetch` 2.31.0 on testnet, when our facilitator verifies and
      settles it, then it moves the money, and the transaction hash is recorded
- [ ] Given the requests of 0136's parity run, when `examples/http-api` and the Rust crate's
      example answer them, then they answer the same, framework differences aside
