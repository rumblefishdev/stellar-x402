---
id: "0037"
title: "MCP discovery server prototype: list, inspect and pay for Bazaar resources"
type: FEATURE
status: active
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
  - date: "2026-10-12"
    status: active
    who: karolkow
    note: >
      Work started.
  - date: "2026-10-12"
    status: active
    who: karolkow
    note: >
      Shape settled before further code (decisions below): get_resource reads one resource
      through a `resource` filter instead of paging the catalog; prices come only from the live
      402; buyer-side address guard, reserved budget and testnet-only; search and paid MCP tools
      stay out of this task.
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
- [ ] Given the locally built `stellar-x402-mcp` CLI and the README's config, when it is added to an MCP client such as
      Claude Desktop, then an agent can list a resource and pay for it end to end on testnet
- [ ] Unit tests cover the filters, the limits, the error mapping and the 402 retry, against fakes

## Decisions so far

Settled on 2026-10-12, before the rework of PR #21. Each line: what was decided and why.

- **Tools stay `list_resources`, `get_resource`, `call_paid_http`.** `list_resources` returns
  summaries; `get_resource` returns the full entries. A full entry is about 6x a summary
  (median 3.5k vs 0.6k characters, measured on 100 live Bazaar entries), so browsing stays cheap.
- **`get_resource` makes one request: `GET /discovery/resources?resource=<canonical URL>`.**
  It returns every entry under that URL (one URL can hold several tools, methods or networks)
  and checks that each returned entry has that URL, failing loudly otherwise. No paging of the
  catalog: the earlier scan needed up to 50 requests and could not reach most of a large
  catalog. The `resource` filter is asked of 0032; the fake catalog serves it until then.
- **Paging of `list_resources` is driven by the agent** (`limit`, `offset`, `total`); a tool
  never loops over pages by itself.
- **No text search in this task.** `query` is added when our catalog serves
  `GET /discovery/search` (spec v2 §8.2; ranking belongs to the Discovery lane).
- **Targets the fake catalog, then ours.** No handling for foreign catalogs that ignore filters.
- **Prices come only from the live 402.** The catalog is a snapshot refreshed on settle; a call
  never blocks on a catalog/402 difference (that would stop a seller from ever being paid after
  a price change). The catalog price is returned beside the paid price for information.
- **Buyer-side address guard in `call_paid_http`:** https only; no loopback, private or
  link-local hosts, checked on the resolved IP; no automatic redirects; response size and time
  limits; an `allowInsecureLocal` switch, off by default, only for the local test seller.
- **Budget:** a per-call price cap and a budget for the life of the process, reserved before
  signing and released only on a confirmed failure; atomic units per asset.
- **Testnet only:** the server refuses to start with `stellar:pubnet`; the README says to use a
  testnet-only key.
- **Errors are loud:** a fixed code list (adds `invalid_input` for malformed tool input); the
  cause of a catalog failure goes to the server log, never to the agent; our own bugs are not
  reported as `upstream_error`.
- **Seller-written fields** are bounded with the `packages/bazaar` limits; an entry over the
  extension size limit is rejected with a code. Every tool declares an `outputSchema`.
- **Logic stays in `packages/mcp`.** The SDK buyer/agent helpers are a later tranche.
- **`@x402/*` follows the workspace:** 2.27 until PR #22 (0016) merges, then 2.28.

## Not yet decided

- Page size and maximum for `/discovery/resources` (0032); the fake uses 20 and 50.

## Out of scope

- Text search (`query`), until the catalog serves `/discovery/search`.
- `call_paid_mcp_tool`: a separate task together with `examples/mcp-metered`, after `upto`
  settlement (0015).
- End-to-end on our own catalog and facilitator: possible after 0032 and 0009/0026; this task
  ends with e2e on the fake catalog and the public x402.org testnet facilitator.
