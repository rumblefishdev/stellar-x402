---
id: "0137"
title: "Search tool in the MCP server, over /discovery/search"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0008"]
related_tasks: ["0120", "0037", "0042", "0046", "0068"]
tags: [mcp, bazaar, search, priority-medium, effort-small, discovery]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan: split out of 0120, so the route and the MCP
      tool can be built by different people once the route's types are agreed.
---

# Search tool in the MCP server, over `/discovery/search`

## Summary

As an agent using our MCP server, I want a tool that searches the Bazaar in natural language, so I
can find a paid service and then call it with the paid-call tool.

## Context

- 0120 holds the route `/discovery/search` and, until now, the MCP tool over it. This task takes
  the tool; 0120 keeps the route and the ranking.
- The MCP server (`packages/mcp`, `apps/mcp-local`) lists resources through
  `/discovery/resources` today (0037, 0046).
- The tool depends only on the route's request and response types, which 0120 agrees first. It
  can be built and tested against a fake of the route.

## Implementation Plan

- A search tool whose input is a query and the route's filters, and whose output is the route's
  results in the shape the paid-call tool accepts.
- Paging through the route's cursor, and `partialResults` passed on to the agent.
- The e2e suite of `apps/mcp-local` covers search, then a paid call on a result.

## Acceptance Criteria

- [ ] Given the MCP server, when an agent calls the search tool with a query, then it gets the
      same results, in the same order, as `/discovery/search` for that query
- [ ] Given more results than one page, when the agent asks for the next page, then the tool uses
      the route's cursor
- [ ] Given a response with `partialResults: true`, when the tool answers, then the agent is told
      the results may be incomplete
- [ ] Given a search result, when the agent passes it to the paid-call tool, then the call is paid
      and answered on testnet, and the run is recorded for 0132
- [ ] 0120's acceptance criterion for the MCP tool points to this task
