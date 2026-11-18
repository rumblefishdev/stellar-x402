---
id: "0085"
title: "Give seller-fetch its own error codes, translated by the MCP"
type: FEATURE
status: backlog
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

- [ ] Given each guard refusal, when the MCP returns it, then the agent sees the same tool error
      code and message as before (existing MCP tests unchanged)
- [ ] Given a seller URL that redirects, when the facilitator checks it, then the attempt's reason
      is `redirect`, not `unsafe_url`
- [ ] `packages/seller-fetch` contains no MCP or agent wording
