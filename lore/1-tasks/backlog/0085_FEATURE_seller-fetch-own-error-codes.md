---
id: "0085"
title: "Give seller-fetch its own error codes, translated by the MCP"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0063", "0037"]
tags: [seller-fetch, mcp, facilitator, priority-medium, effort-small]
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
  (`unsafe_url`, `upstream_error`, `response_too_large`) and messages written for an agent
  (`guard.ts:6-9`): it moved out of `packages/mcp` with its vocabulary (#72).
- The facilitator stores those codes as attempt reasons and metric labels
  (`apps/facilitator/src/catalog/seller-check.ts`), so one `unsafe_url` covers three causes:
  no `https`, a private address, a redirect.
- `asToolError` (`packages/mcp/src/results.ts`, #88) is the one place the MCP turns a guard error
  into a tool error.

## Implementation

- `SellerFetchError` codes name the cause (`not_https`, `not_public`, `redirect`, `too_large`,
  `timeout`, `network`); messages are plain facts, not advice to an agent.
- `asToolError` maps them to today's MCP codes and messages.
- The facilitator's attempt reasons and metric labels take the new codes; ADR 0008 lists them.

## Acceptance Criteria

- [ ] Given each guard refusal, when the MCP returns it, then the agent sees the same tool error
      code and message as before (existing MCP tests unchanged)
- [ ] Given a seller URL that redirects, when the facilitator checks it, then the attempt's reason
      is `redirect`, not `unsafe_url`
- [ ] `packages/seller-fetch` contains no MCP or agent wording
