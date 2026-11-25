---
id: "0162"
title: "Pay for a seller's MCP tool from the MCP server: call_paid_mcp_tool"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0037", "0137", "0041", "0044"]
tags: [mcp, dev-tools, priority-low, effort-medium]
links: []
history:
  - date: "2026-11-24"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0137: search returns sellers' paid MCP tools, which call_paid_http can't pay.
      0037 left this tool out of scope; no task carried it on.
---

# Pay for a seller's MCP tool from the MCP server: `call_paid_mcp_tool`

## Summary

As an agent using our MCP server, I want to pay for a paid tool on a seller's MCP server, so a
search result of type `mcp` is as usable as an HTTP one.

## Context

- The Bazaar catalogs both HTTP endpoints and MCP tools (RFP 7, "Catalog both HTTP endpoints and
  MCP tools"). `call_paid_http` pays only HTTP: request, 402, retry with the payment header. A paid
  MCP tool asks for payment inside MCP: the tool call fails with "payment required" and is retried
  with the payment in `_meta`.
- 0037 put `call_paid_mcp_tool` out of scope, "a separate task together with
  `examples/mcp-metered`, after `upto` settlement (0015)". 0015 is done; `examples/mcp-metered` is
  still a placeholder. A tool with a fixed (`exact`) price does not need `upto`.
- Upstream `@x402/mcp` 2.31.0, already in the lockfile, has a paying client
  (`wrapMCPClientWithPayment`).
- 0137's search tool description says MCP tools are listed but not paid; this task changes that
  sentence.
- 0041 (two example integrations) may use a paid MCP seller as its second example.

## Implementation Plan

- A tool that connects to the seller's MCP server named by the listing, calls the tool with the
  agent's arguments, and pays through upstream's client within the same limits as
  `call_paid_http` (per call, daily budget, allowed assets).
- The same closed error codes as `call_paid_http`, and the same address guard for the server URL.
- A test seller with one paid MCP tool, for the tests and the e2e.

## Acceptance Criteria

- [ ] Given a paid MCP tool on testnet, when the agent calls it through the new tool, then it is
      paid and answered, and the settlement transaction is returned
- [ ] Given a price over the per-call limit or the remaining budget, then nothing is signed and the
      agent gets the same error code `call_paid_http` gives
- [ ] Given 0137's search tool, then its description no longer says MCP tools can't be paid
