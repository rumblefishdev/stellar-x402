---
id: "0085"
title: "Give seller-fetch its own error codes, translated by the MCP"
type: FEATURE
status: active
owner: bstruzyk
milestone: 2
related_adr: ["0008"]
related_tasks: ["0063", "0037", "0075"]
tags: [seller-fetch, mcp, facilitator, priority-medium, effort-small, dev-tools]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063 (decision row 35): seller-fetch kept the MCP's error vocabulary when it
      moved out of packages/mcp. Starts after 0063's PRs are merged.
  - date: "2026-11-20"
    status: active
    who: bstruzyk
    note: >
      Started: seller-fetch names each refusal's cause, asToolError maps the new codes to today's
      MCP codes, and the facilitator's attempt reasons take them.
---

# Give seller-fetch its own error codes, translated by the MCP

## Summary

As the operator reading `catalog_attempts`, I want a failed seller request to say what happened
(not https, not a public address, a redirect, too large, a timeout, a network failure), so that a
refused listing's reason is exact. As a buyer's agent, I want the same tool errors as today.

## Context

- `packages/seller-fetch` (`src/guard.ts`) throws `SellerFetchError` with the MCP's codes
  (`unsafe_url`, `upstream_error`, `response_too_large`, `guard.ts:13`): it moved out of
  `packages/mcp` with its vocabulary (#72). The messages are already plain facts ("Only https
  URLs are called."); the agent wording left is in comments (`guard.ts:6-7`, `:110`).
- The facilitator stores those codes as attempt reasons and metric labels
  (`apps/facilitator/src/catalog/seller-check.ts:21`, `:43`), so one code covers several causes.
  Throw sites in `guard.ts` (2026-11-18):
  - `unsafe_url` (5): the host resolves to a private address (`:75`), not a URL (`:91`), not
    https (`:97`), a private IP literal (`:100`), a redirect (`:152`).
  - `upstream_error` (2): the request failed (`:145`: a network failure or the deadline, told
    apart only by the error), the body did not arrive in full (`:171`: a stall past the deadline
    or a dropped connection).
  - `response_too_large` (2): headers (`:142`), body (`:163`).
- `asToolError` (`apps/mcp-local/src/results.ts`, #88) is the one place the MCP turns a guard error
  into a tool error; today it passes the code through.
- The metric catalog keeps `reason` as a free label (`packages/metrics-catalog/src/index.ts`), so
  new codes need no schema change.
- 0075's seller guide explains the listing refusal reasons, so it follows these codes.

## Implementation

- `SellerFetchError` codes name the cause (`not_https`, `not_public`, `redirect`, `too_large`,
  `timeout`, `network`), with every throw site above mapped to one; decide where "not a URL" and
  a body cut off go (a code of their own, or `not_https` and `network`/`timeout`).
- `asToolError` maps them to today's MCP codes and messages.
- The facilitator's attempt reasons and metric labels take the new codes; ADR 0008 lists them.
- Tests and docs that name `unsafe_url` follow: `packages/seller-fetch/test/guard.test.ts`,
  `apps/facilitator/test/cataloger.test.ts`, `apps/mcp-local/README.md` (its codes table) and
  `apps/mcp-local/e2e/test/get-resource.ts` stay on the MCP codes; check each.

## Acceptance Criteria

- [x] Given each guard refusal, when the MCP returns it, then the agent sees the same tool error
      code and message as before (existing MCP tests unchanged)
- [x] Given a seller URL that redirects, when the facilitator checks it, then the attempt's reason
      is `redirect`, not `unsafe_url`
- [x] `packages/seller-fetch` contains no MCP or agent wording

## Design Decisions

### From Plan

1. **Six cause codes**: `not_https`, `not_public` (an IP in the URL or a name resolving to one),
   `redirect`, `response_too_large` (headers or body; see 5), `timeout`, `network`, exported as
   `SellerFetchCode`. Messages stay as they were: they are already plain facts, so the MCP shows
   the agent the same text.
2. **`asToolError` maps them back**: `not_*` and `redirect` to `unsafe_url`,
   `response_too_large` to itself, `timeout` and `network` to `upstream_error`, in one exhaustive
   table.

### Emerged

3. **"Not a URL" is a code of its own, `not_a_url`**: the task left it open (its own code or
   `not_https`). A string that does not parse has no scheme, so `not_https` would misname it, and
   the operator's reason is meant to be exact. It cannot reach the facilitator in practice
   (`bazaar.normalize` checks the URL first); the MCP shows it as `unsafe_url` as before.
4. **A request or body cut off is `timeout` only when the deadline has passed**: both throw
   sites (`guard.ts` request and body) check `deadline.aborted`; anything else is `network`. So
   a request ended by its own signal (the caller gave up, e.g. an MCP client closing its stream)
   is `network`, not `timeout`.
5. **`response_too_large`, not the task's `too_large`** (renamed in review, PR #220): in
   `catalog_attempts` `too_large` already means a listing over the entry limits twice (the
   payment's `rejected` reason from `bazaar`, and the seller stage's outcome), so a third meaning
   would mix causes in one query. `response_too_large` is the reason it was before 0085, with the
   same meaning, so rows before and after agree, and it is the MCP's code for the same cause.
6. **The MCP log keeps the exact cause**: `asToolError` puts the seller-fetch code at the head of
   the tool error's `detail` (logs only), so a `payment_unknown` after a redirect still logs
   `redirect` while the agent sees the same code and message as before.
7. **An MCP seller that answers nothing by the deadline is `timeout`** (was `upstream_error`
   written by hand in `seller-check.ts`).

## Issues Encountered

- **Modified tests** (intentional, the codes changed by design):
  `packages/seller-fetch/test/guard.test.ts` asserts the new codes, and its caller-abort test
  now expects `network`. `apps/facilitator/test/cataloger.test.ts`: a seller or MCP tool that
  never answers is `timeout`, an MCP server shut down is `network`, and the private-address case
  now uses https (`not_public`) as well as http (`not_https`): over http the scheme was refused
  before the address, so the address check was never reached there.
- **New tests**: guard `not_a_url`, `timeout` (stalled body), `redirect` (301/302/307),
  `network` (a server dropping the connection); facilitator: the attempt row's reason is
  `redirect`; `apps/mcp-local/test/results.test.ts`: every code's mapping.
