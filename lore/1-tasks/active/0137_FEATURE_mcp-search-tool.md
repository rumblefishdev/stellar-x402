---
id: "0137"
title: "Search tool in the MCP server, over /discovery/search"
type: FEATURE
status: active
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

- [ ] Given the MCP server, when an agent calls the search tool with a query and filters, then it
      gets the same resources, in the same order, as `/discovery/search` for that query and those
      filters (no network: both networks)
- [ ] Given more results than one page, when the agent asks for the next page, then the tool uses
      the route's cursor; given a cursor the route refuses, then the agent gets `invalid_cursor`
- [ ] Given a response, when the tool answers, then `partialResults` is passed on and the output
      schema says what `true` means
- [ ] Given our facilitator on testnet (`CATALOG_LIST_LOCAL=true`), when a paid call catalogs a
      seller, the agent finds it with the search tool and pays for the result, then the call is
      paid and answered, and the run is recorded for 0132
- [x] 0120's acceptance criterion for the MCP tool points to this task
