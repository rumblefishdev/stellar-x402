---
id: "0046"
title: "Simplify the MCP server after 0037, tidy its e2e suite and move the tool schemas out of server.ts"
type: FEATURE
status: active
related_adr: []
related_tasks: ["0037"]
tags: [mcp, tests, structure, priority-low, effort-small]
links: []
history:
  - date: "2026-10-14"
    status: backlog
    who: karolkow
    note: "Spawned from 0037 future work (W299, W437, W438, W442)."
  - date: "2026-10-15"
    status: active
    who: karolkow
    note: >
      Started with an over-engineering review of the whole 0037 server (W477 A): what goes, what
      stays, in a refactor PR and a behaviour PR.
---

# Simplify the MCP server after 0037, tidy its e2e suite and move the tool schemas out of server.ts

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

## Simplification (review 2026-10-15, W477 A)

The prototype was optimised early; the agent calling it is capable. A review of the whole server
(~1,100 source lines) found what can go.

Without a change in behaviour, one `[refactor]` PR:

- drop the unused `@x402/mcp` dependency of `packages/mcp`;
- drop the special start-up messages for `STELLAR_X402_BUDGET` and `STELLAR_X402_STATE_FILE`: the
  general "is not a setting of this server" still stops the start and names the variable;
- drop `STELLAR_X402_NETWORK`, which accepts one value and changes nothing: `pubnet` still stops
  the start, as an unknown variable;
- e2e: read Horizon through the Stellar SDK the suite already imports, not hand-written requests;
- tests: cross-process counting is proven once, by the 20-process test; the in-process and e2e
  repeats go.

Changing behaviour, one PR, each a guard the prototype does not need (money stays bounded: the
per-call limit and the exact daily count stay):

- the signing time limit (`signWithin`): a hung RPC makes the call wait until the MCP client gives
  up; a late signature is still never sent and the amount goes back;
- the daily pre-check while choosing an offer: the exact count in the transaction stays; a seller
  with several offers can rarely get `over_budget` where a cheaper offer would fit;
- the input-schema depth limit in `get_resource`: a deep seller schema (≤ 16 KiB) reaches the
  agent as data;
- the start-up error for payment settings without a key: the server starts browsing only and says
  so in its log;
- deleting budget rows older than 7 days: the file keeps the full history.

Kept: the address guard, the price-above-zero check, `BEGIN IMMEDIATE` and one database open per
payment, the after-sending outcomes, the 300 s cap, loud unknown variables, `allowInsecureLocal`,
`insufficient_funds`, and the upstream catalog client.

## Acceptance Criteria

- [ ] One `[structure only]` PR; unit tests unchanged; an e2e run passes on its head
- [ ] `server.ts` holds no schema
