---
id: "0046"
title: "Tidy the MCP e2e suite and move the tool schemas out of server.ts"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0037"]
tags: [mcp, tests, structure, priority-low, effort-small]
links: []
history:
  - date: "2026-10-14"
    status: backlog
    who: karolkow
    note: "Spawned from 0037 future work (W299, W437, W438, W442)."
---

# Tidy the MCP e2e suite and move the tool schemas out of server.ts

## Summary

Structure-only follow-ups of 0037: the e2e script's name and file size, whether its results file
is committed, and the tool schemas still living in the composition root.

## Context

0037 left these as named follow-ups; none changes what the server does.

## Implementation

- Rename `pnpm e2e:testnet` to `pnpm mcp:e2e`, next to `contracts:e2e` (W437), README and PR
  texts with it.
- Split `apps/mcp-local/e2e/test/mcp.e2e.test.ts` (1,074 lines) by scenario group, with shared
  setup and one secret scan across files (vitest `globalSetup`) (W438).
- Decide whether `results/testnet-results.json` (1,610 lines, rewritten on every run) is
  committed or git-ignored with the evidence kept in the PR and task (W442, open).
- Move the input and output schemas of `get_resource` and `call_paid_http` to `preview.ts` and
  `pay.ts`, as `list_resources`' already live in `catalog.ts`; `server.ts` only registers (W299 A).

## Acceptance Criteria

- [ ] One `[structure only]` PR; unit tests unchanged; an e2e run passes on its head
- [ ] `server.ts` holds no schema
