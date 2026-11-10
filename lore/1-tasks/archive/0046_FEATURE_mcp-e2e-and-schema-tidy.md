---
id: "0046"
title: "Simplify the MCP server after 0037, tidy its e2e suite and move the tool schemas out of server.ts"
type: FEATURE
status: completed
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
  - date: "2026-11-04"
    status: active
    who: karolkow
    note: >
      Added: make the red e2e suite pass, with its own facilitator and its own time limit. Found in
      the review of 0111's PR #124.
  - date: "2026-11-06"
    status: active
    who: karolkow
    note: >
      Added: `list_resources` takes the Bazaar spec's `scheme` filter, which its strict input
      refused. Found in an audit of the repo.
  - date: "2026-11-10"
    status: completed
    who: karolkow
    note: >
      Closed. The plan's five items were done before (premise review); the results file stays
      committed, as the repo's six other live results do. The red suite passes with its own
      facilitator (#127). Its runs found the /verify and /settle answers to an RPC with no verdict,
      fixed in #152, #159, #161 and #168; #162 (a Horizon bound) closed unmerged on 0 Horizon
      hangs in production logs. 11 merged PRs.
---

# Simplify the MCP server after 0037, tidy its e2e suite and move the tool schemas out of server.ts

## Summary

Structure-only follow-ups of 0037: the e2e script's name and file size, whether its results file
is committed, and the tool schemas still living in the composition root.

## Context

0037 left these as named follow-ups; none changes what the server does.

## Premise

Reviewed 2026-11-10 against `develop` at 1f2a3bb8, from this task's Summary, Context and
Implementation only:

- The rename is done: `package.json:25` has `mcp:e2e`.
- The split is done: `mcp.e2e.test.ts` is 40 lines and imports six group files; its one secret
  scan (E-23) covers every capture, so a vitest `globalSetup` isn't needed.
- The schemas moved: `packages/mcp/src/server.ts` imports them from `catalog.ts`, `preview.ts`
  and `pay.ts` and defines none.
- The `scheme` filter is in: `packages/mcp/src/catalog.ts:43-46`. Against our own catalog it
  serves `exact` only (`apps/facilitator/src/http/discovery.ts`).
- Open: whether `results/testnet-results.json` stays committed. It is rewritten on every run
  (about 1,577 lines) and changed in 3 commits of this task. The owner decides.
- The Summary's "structure only" no longer fits: the red-suite work below changed the e2e and the
  facilitator, so the AC asking for one `[structure only]` PR can't be met as written.

## Implementation

- Rename `pnpm e2e:testnet` to `pnpm mcp:e2e`, next to `contracts:e2e` (W437), README and PR
  texts with it.
- Split `apps/mcp-local/e2e/test/mcp.e2e.test.ts` (1,074 lines) by scenario group, with shared
  setup and one secret scan across files (vitest `globalSetup`) (W438).
- Decide whether `results/testnet-results.json` (1,610 lines, rewritten on every run) is
  committed or git-ignored with the evidence kept in the PR and task (W442, open).
- Move the input and output schemas of `get_resource` and `call_paid_http` to `preview.ts` and
  `pay.ts`, as `list_resources`' already live in `catalog.ts`; `server.ts` only registers (W299 A).
- `list_resources` takes the `scheme` filter that the Bazaar spec and upstream's
  `ListDiscoveryResourcesParams` define and our `/discovery/resources` already accepts. Its strict
  input refused it, so an agent couldn't ask for `upto` listings only.

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

## The red suite (2026-11-04)

`pnpm mcp:e2e` was last green on 2026-10-15. Two full runs on SDK 16.4.1 failed 27 and 22 of 119
rows, with no XDR error in the second run's log. Measured causes:

- Paid scenarios set a 3 s limit (`test/context.ts`). Building a payment took 0.8 to 14.5 s in 20
  calls, because the public testnet RPC answers slowly: `curl` alone, 0.3 to 6.6 s in 30 calls. All
  18 rows of this kind answered "The time limit passed before the payment was sent".
- E-21 and E-22 settle through the public x402.org facilitator. Direct calls to its `/settle` in 3
  rounds: 200 at 14.3 s, then 504 at 15.2 s twice, and all 3 payments landed on chain.

| # | What is done | From | vs the task | Who does the same (checked) |
| --- | --- | --- | --- | --- |
| 1 | The suite starts our built facilitator, and the example seller settles through it | owner | beyond it | upstream's e2e starts its own facilitators (`e2e/test.ts:1387-1400`@b9cbd85) |
| 2 | Settings with a key get a time limit past what signing takes; settings without a key keep 3 s | owner | beyond it | checked: no upstream rule |
| 3 | `/verify` answers 503 `rpc_unavailable` with `Retry-After: 5` when the RPC gives no answer, instead of 500 (PR #152) | owner | beyond it | no x402 rule for a facilitator; HTTP 503 (RFC 9110 §15.6.4) |

The first limit for real payments, 30 s, failed E-21 and E-22 in 1 of 2 runs with the money moved:
it can't hold signing and our facilitator's own 30 s settle budget. At 55 s, under the MCP client's
60 s, 3 of 3 full runs passed all 121 rows.

After the review each run got a schema of its own, one channel, and the facilitator's log on stderr.
3 more full runs: 2 passed all 121 rows. In the third, E-22a got `payment_rejected` with no money
moved, because `/verify` hit its 10 s limit per RPC URL on the slow public RPC.

## Acceptance Criteria

- [ ] One `[structure only]` PR; unit tests unchanged; an e2e run passes on its head (not met as
      written: the structure changes landed in earlier PRs, and the red-suite work changed behaviour)
- [x] `server.ts` holds no schema: it imports them from `catalog.ts`, `preview.ts` and `pay.ts`
- [x] `pnpm mcp:e2e` passes on real testnet, with E-21 and E-22 settled by the suite's own facilitator

## Closed (2026-11-10)

- **Results file:** `apps/mcp-local/e2e/results/testnet-results.json` stays committed, like the
  live results under `apps/facilitator/test/live/results/`, `conformance/results/` and
  `contracts/upto-proxy/e2e/results/`. A change for all of them is one decision, not this file's.
- **PRs from the e2e runs:** #152 (`/verify` 503 `rpc_unavailable` with its alarm), #159
  (`/settle`'s checks answer `settle_exact_stellar_rpc_unavailable`), #161 (the store guard a
  claim sweep relies on, pinned by a test), #168 (no verdict from any RPC URL is a 503). They change
  facilitator behaviour; their code belongs to 0049's topic, and later fixes there go to 0049.
- **Left to other tasks:** deploying the `verify-rpc-unavailable` alarm (0027); putting gateway.fm
  first among the testnet `RPC_URLS` (0029 decision 8), after 79 timeouts of the first URL in
  3.5 days of production logs; hedged RPC reads (0049).
