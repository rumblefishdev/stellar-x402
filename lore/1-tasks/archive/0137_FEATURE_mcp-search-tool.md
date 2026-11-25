---
id: "0137"
title: "Search tool in the MCP server, over /discovery/search"
type: FEATURE
status: completed
owner: karolkow
milestone: 2
related_adr: ["0008", "0014"]
related_tasks: ["0120", "0037", "0042", "0046", "0068", "0044", "0162"]
tags: [mcp, bazaar, search, priority-medium, effort-small, dev-tools]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-12"
    status: backlog
    who: karolkow
    note: >
      Created with okarcz from the Milestone 2 plan: split out of 0120, so the route and the MCP
      tool can be built by different people once the route's types are agreed.
  - date: "2026-11-24"
    status: active
    who: karolkow
    note: >
      Started. The route is on develop (PR #226) with upstream's search types, and upstream's
      client already has `bazaar.search()`, so nothing blocks the tool. Criteria restated after the
      grilling round: network default, refused cursor, partialResults, the e2e on our facilitator.
  - date: "2026-11-25"
    status: completed
    who: karolkow
    note: >
      Closed after PR #245. `search_resources` in apps/mcp-local, a new error code
      `invalid_cursor`; 168 unit tests (22 new), testnet e2e 125 checks, 0 failed, with the new
      scenario E-25 (search, then a paid call on the result). Follow-up 0162 (paying MCP tools).
---

# Search tool in the MCP server, over `/discovery/search`

## Summary

As an agent using our MCP server, I want a tool that searches the Bazaar in natural language, so I
can find a paid service and then call it with the paid-call tool.

## Context

- 0120 holds the route `/discovery/search` and the ranking; this task holds the MCP tool over it.
  The route is on develop (PR #226), ranked by words until 0120's meaning PR, and answers with
  upstream's `SearchDiscoveryResourcesResponse`.
- The MCP server (`apps/mcp-local`) lists resources through `/discovery/resources` today (0037,
  0046). `list_resources` stays; search is a second tool.
- Upstream's client already searches: `withBazaar(...).extensions.bazaar.search()` in
  `@x402/extensions` 2.31.0. It throws a plain `Error` with the HTTP status in its message.
- The server pays on testnet only (pubnet: 0044) and only for HTTP resources (MCP tools: 0162).

## Implementation Plan

- A `search_resources` tool: a query, the route's filters, `limit` and `cursor`; it answers with
  the same trimmed entries `list_resources` gives, `partialResults` and the next cursor.
- Without a `network` the route searches both networks; the tool's description names the network
  this server pays on, and says only HTTP resources can be paid.
- A cursor the route refuses is the error code `invalid_cursor`, so the agent starts again; any
  other `400` is `invalid_input`, naming the parameter only when it is one of the tool's inputs;
  any other catalog failure stays `upstream_error`.
- The e2e suite of `apps/mcp-local` runs search, then a paid call on a result, against our own
  facilitator.

## Acceptance Criteria

- [x] Given the MCP server, when an agent calls the search tool with a query and filters, then it
      gets the same resources, in the same order, as `/discovery/search` for that query and those
      filters (no network: both networks)
- [x] Given more results than one page, when the agent asks for the next page, then the tool uses
      the route's cursor; given a cursor the route refuses, then the agent gets `invalid_cursor`
- [x] Given a response, when the tool answers, then `partialResults` is passed on and the output
      schema says what `true` means
- [x] Given our facilitator on testnet (`CATALOG_LIST_LOCAL=true`), when a paid call catalogs a
      seller, the agent finds it with the search tool and pays for the result, then the call is
      paid and answered, and the run is recorded for 0132
- [x] 0120's acceptance criterion for the MCP tool points to this task

## Implementation Notes

- `apps/mcp-local/src/catalog.ts`: the tool's input (the list's filters without `offset`, plus
  `query` and `cursor`), the route's answer and the tool's output; `refusedParam` reads the
  refused parameter from upstream's error text.
- `apps/mcp-local/src/server.ts`: registers `search_resources` (read-only) through upstream's
  `bazaar.search()`, under the same time limit as `list_resources`.
- E2E: the harness starts our facilitator with `CATALOG_LIST_LOCAL=true`; E-25 searches it,
  compares with a direct `GET /discovery/search`, then pays for the result (tx
  `a94b6cb6793a15d9dd55d8c1860e53f303fe268f5510f40758401dfa4e19b1c4`).

## Issues Encountered

- **E-04 red on develop**: since 481e3daa `list_resources` lists only the pay network by default;
  the test still expected both. Test-only fix on develop (3c045e60), not a regression.
- **Modified tests**: `test/pay.test.ts` and E-02/E-03 now expect `search_resources` in the tool
  list.

## Design Decisions

### From Plan

1. **A second tool, `list_resources` stays**: the route refuses an empty query, so an agent could
   not browse with search alone.
2. **Both networks without a `network`**: the real catalog is mostly pubnet; the description says
   the server pays on `PAY_NETWORK` only, and only for HTTP resources.
3. **`partialResults` passed as a field**: its meaning is in the output schema, with no warning
   text, because words-only ranking always sets it.
4. **Refused cursor is `invalid_cursor`**, read from upstream's error text instead of a second
   request path; a test pins the format.

### Emerged

5. **Any other `400` is `invalid_input`**, and the message names the parameter only when it is
   one of the tool's inputs: the body is the catalog's text, and the agent's model reads it.
6. **MCP-type results stay in search**: paying them is 0162.

## Future Work

- Paying MCP tools: 0162.
- Binding the cursor to its query and filters in the route: a route change, after 0120's meaning
  PR.
