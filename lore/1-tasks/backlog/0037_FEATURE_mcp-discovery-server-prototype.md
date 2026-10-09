---
id: "0037"
title: "MCP discovery server prototype: list, inspect and pay for Bazaar resources"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0008"]
related_tasks: ["0032", "0031", "0016"]
tags: [mcp, bazaar, agents, priority-medium, effort-medium, discovery]
links:
  - ../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
  - ../../../packages/mcp/package.json
  - ../../../apps/mcp-local/package.json
history:
  - date: "2026-10-09"
    status: backlog
    who: claude
    note: >
      Created at okarcz's request as a self-contained head start on the post-T1 MCP deliverable,
      intended for the team's fourth developer. Tagged Discovery as the closest board lane.
---

# MCP discovery server prototype: list, inspect and pay for Bazaar resources

## Summary

As an agent developer, I want an MCP server that lists Stellar Bazaar resources and calls a
paid one, paying on Stellar testnet within limits I set, so that an agent can find and pay for
x402 services as part of its normal tool-use loop.

**Lane:** Discovery (closest board lane; owner: the fourth developer) · **Milestone:** 2 (the
RFP's MCP discovery server, outside T1)

## Context

- The RFP requires an MCP discovery server with search and paid-call tools, structured and
  deterministic inputs and outputs, and machine-readable error codes (technical architecture §5).
- `packages/mcp` (tool logic) and `apps/mcp-local` (the `stellar-x402-mcp` CLI, stdio) are
  placeholders today. Their dependencies already list `@modelcontextprotocol/sdk` and `@x402/mcp`.
- **Independent of the T1 lanes.** The discovery response shape comes from upstream
  (`@x402/extensions`), not from our code, so a fake catalog stands in until 0032 ships. Paid calls
  go through the public Stellar testnet facilitator until ours is deployed (0026). Both switch by
  config, not code.
- **Out of scope:** `/discovery/search` and a search tool. The endpoint isn't designed yet and
  belongs to the Discovery lane; agree its contract before adding the tool.
- Clean-room rule: no OpenZeppelin relayer code (AGPL), not even as reference.

## Implementation

- **Versions:** `@x402/*` on `~2.28.0`, matching the workspace upgrade in 0016 (the package
  still pins 2.27).
- **Tools** in `packages/mcp`:
  - `list_resources`: `GET /discovery/resources` with the `type`, `payTo`, `network`,
    `extensions`, `limit` and `offset` filters; returns price, asset, network and description.
  - `get_resource`: one entry's full payment terms and input schema.
  - `call_paid_http`: calls an HTTP resource; on 402 checks the terms against the limits, signs
    the Soroban auth entry with the upstream `@x402/stellar` client and retries; returns the
    response and the settlement transaction hash.
  - `call_paid_mcp_tool` (optional in this task): the same for paid MCP tools via upstream
    `@x402/mcp`.
- **Spend limits** from config, enforced before signing: maximum price per call, a budget per
  process or day, allowed assets and networks. Over a limit the tool returns an error code and
  signs nothing; the model is never asked to approve.
- **Error codes:** one fixed list (for example `over_price_limit`, `over_budget`,
  `insufficient_funds`, `authorization_expired`, `resource_not_found`, `payment_rejected`,
  `upstream_error`), with every x402 and Stellar failure mapped to one of them.
- **Key handling:** the buyer's secret comes from env or local config and never appears in tool
  output or logs.
- **Untrusted catalog data:** seller-written fields are returned as data, length-bounded, never
  as instructions.
- **`apps/mcp-local`:** the CLI wiring config (facilitator and discovery URLs, network, key,
  limits) and stdio transport; a README with a Claude Desktop config example.
- **Test fixtures:** a fake catalog (a few `http` and `mcp` entries) and a paid test endpoint,
  which can grow into `examples/http-api`.

## Acceptance Criteria

- [ ] Given a catalog (the fake one or a real `/discovery/resources`), when `list_resources` is
      called with any combination of the filters, then it returns only matching entries with
      their price, asset, network and description, in a stable structured shape
- [ ] Given a paid HTTP resource on testnet within the limits, when `call_paid_http` is called,
      then the server pays in testnet USDC, returns the resource's response, and the settlement
      transaction hash is recorded in the task
- [ ] Given a resource priced above the per-call limit, or a call that would exceed the budget,
      when it is called, then the tool returns `over_price_limit` or `over_budget` and nothing is
      signed or sent
- [ ] Given any failure (unfunded payer, expired authorization, unknown resource, facilitator
      rejection), when it happens, then the tool returns a code from the fixed list, never only
      free text
- [ ] Given any tool output or log line, then the buyer's secret never appears in it
- [ ] Given the published CLI and the README's config, when it is added to an MCP client such as
      Claude Desktop, then an agent can list a resource and pay for it end to end on testnet
- [ ] Unit tests cover the filters, the limits, the error mapping and the 402 retry, against fakes
