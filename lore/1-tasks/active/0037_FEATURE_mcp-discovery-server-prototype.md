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
  - date: "2026-10-13"
    status: active
    who: karolkow
    note: >
      Shape revised after reviewing the whole task against the RFP and existing x402 MCP servers:
      two tools (get_resource dropped, list_resources carries the input description), budget
      counted before signing and never given back, no DNS check (https is the guard),
      insufficient_funds from the payer's simulation. Source 567 -> 487 lines; 52 tests.
  - date: "2026-10-13"
    status: active
    who: karolkow
    note: >
      get_resource is back, as a preview of the seller's 402 answer before paying rather than a
      catalog lookup; no catalog filter is needed.
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
    `extensions`, `limit` and `offset` filters; returns price, asset, network, description and
    the input description.
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

- [x] Given a catalog (the fake one or a real `/discovery/resources`), when `list_resources` is
      called with any combination of the filters, then it returns only matching entries with
      their price, asset, network and description, in a stable structured shape
- [x] Given a paid HTTP resource on testnet within the limits, when `call_paid_http` is called,
      then the server pays in testnet USDC, returns the resource's response, and the settlement
      transaction hash is recorded in the task — 2026-10-13, built CLI over MCP stdio, example
      seller, x402.org facilitator: `1278142d1a64faa121958756e45d50ffb2e860966968cf02afe49f758ba713ad`
      and `07e0e4e97ed3c80548e315c3866119ebacfd2140cd0b97192838ded091317f78` (both successful on
      Horizon; buyer 20 → 19.998 USDC, seller 0 → 0.002 USDC, fees paid by the facilitator)
- [x] Given a resource priced above the per-call limit, or a call that would exceed the budget,
      when it is called, then the tool returns `over_price_limit` or `over_budget` and nothing is
      signed or sent — unit tests, and on testnet with the built CLI
- [ ] Given any failure (unfunded payer, expired authorization, unknown resource, facilitator
      rejection), when it happens, then the tool returns a code from the fixed list, never only
      free text
- [x] Given any tool output or log line, then the buyer's secret never appears in it — checked
      on the stderr of three CLI runs on testnet; a malformed key is refused without repeating it
- [ ] Given the locally built `stellar-x402-mcp` CLI and the README's config, when it is added to an MCP client such as
      Claude Desktop, then an agent can list a resource and pay for it end to end on testnet
      (deferred to 0042: needs a catalog a README reader can reach, which 0032 provides; the same
      flow passed over MCP stdio with the SDK client, W279)
- [x] Unit tests cover the filters, the limits, the error mapping and the 402 retry, against fakes

## Decisions so far

Settled on 2026-10-12 and revised on 2026-10-13, after a review of the whole task against the RFP
and existing servers. Each line: what was decided and why.

- **Three tools: `list_resources`, `get_resource`, `call_paid_http`.** `list_resources` returns
  summaries with the entry's input description (`extensions.bazaar.info.input`; 93 characters at
  the median on 100 live Bazaar entries, 967 at most). `get_resource` shows everything before
  paying: it asks the seller without paying and returns its 402 answer, the same terms
  `call_paid_http` would pay and the seller's input and output description. The catalog cannot
  return one entry (the upstream list only filters by type, payTo, network and extension), so
  the seller is asked instead of adding a `resource` filter to 0032; the answer is always current.
  HTTP resources only, as paid MCP tools are out of scope.
- **An own server, kept thin.** `nirholas/x402-bridge` (Apache-2.0) does the same job for EVM and
  Solana, with the same guards; it has no Stellar, answers failures in free text, and turns each
  catalog entry into its own tool, which puts seller text into tool descriptions. The RFP needs
  machine-readable codes and an audited server in this repo.
- **Paging of `list_resources` is driven by the agent** (`limit`, `offset`, `total`); a tool
  never loops over pages by itself.
- **No text search in this task.** `query` is added when our catalog serves
  `GET /discovery/search` (spec v2 §8.2; ranking belongs to the Discovery lane).
- **Targets the fake catalog, then ours.** No handling for foreign catalogs that ignore filters;
  the 0030 validator bounds entries on intake. An empty or unparseable `discoveryUrl` stops the
  server, since the upstream client would fall back to x402.org's catalog.
- **The catalog is trusted as the operator's choice:** its request has a time limit but no address
  guard or size cap, unlike seller requests; revisit if a shared or third-party catalog is used
  (PR #28 review, 2026-10-13).
- **Daily budget (PR #32, W331 A, W332 B):** optional, per key and asset, in a local file under an
  own lock file (no lock package in the workspace; SQLite judged too heavy); calendar UTC day.
  Known bound: in a rare race at a dead process's lock the day can be passed by one payment, never
  more than the per-call limit; the record is synced to disk before it replaces the old one.
- **Prices come only from the live 402,** and `call_paid_http` returns only the paid price: the
  agent saw the catalog price in `list_resources`.
- **Which offer is paid:** of the seller's offers, those in an allowed asset and within the
  per-call limit, through an upstream client policy; the library pays the first one left.
- **Budget (revised by W350 A, PR #34):** a per-call price cap and a required daily budget per key
  and asset, in atomic units; the per-process budget is gone (it reset on restart and was not shared
  between sessions). The amount is counted before signing and never given back once signed: a seller cannot
  return it to the budget by claiming the payment failed. When signing fails nothing was sent, and
  the amount goes back (W170).
- **Which offers are paid** also leaves out an authorization longer than 300 s (the `@x402/express`
  default): a longer one could be settled long after the agent got its answer.
- **Buyer-side address guard for every seller request** (`get_resource` and `call_paid_http`):
  https only; the address a name resolves to is checked when the connection is made (an undici
  Agent with its own lookup), and only an ordinary public address passes (`ipaddr.js` names
  every special range, documentation ones included), IP literals included; no automatic redirects;
  a time limit and a response size limit counted after decompression while the body arrives; an `allowInsecureLocal` switch, off by default, only for the local
  test seller. https alone was not enough: an internal service can have a public name and a public
  certificate (W197, after the security review).
- **Testnet only:** only a testnet scheme is registered, so a seller asking for pubnet gets
  `unsupported_payment`; the CLI refuses to start with `stellar:pubnet`, and the README says to
  use a testnet-only key.
- **Errors are loud:** a fixed code list; causes go to the server log, never to the agent. After
  the signed payment leaves the process, any failure is `payment_unknown`, except a refusal: a
  facilitator saying `success: false`, or a seller answering 402 again without a settlement, is
  `payment_rejected` (the amount stays spent either way). An unfunded payer is
  `insufficient_funds`: its simulation fails in the asset contract (`Error(Contract, #13)` for a
  missing trustline, measured on testnet; `#10` for a low balance). An expired authorization
  cannot be told apart: the Stellar facilitator reports it as a failed simulation, so it is
  `payment_rejected` with the reason in the log.
  Exception: input that fails a tool's schema is rejected by the MCP SDK before our handler runs,
  as a loud error without our code (its validation path is private).
- **Seller-written text** is cut with the `packages/bazaar` limits where it is free text
  (descriptions, mime types, error messages); the rest of a seller's 402 is bounded by the HTTP
  header limit of Node's client (16 KiB), and its input schema by the catalog's depth and size
  rules. Every tool declares an
  `outputSchema`.
- **Logic stays in `packages/mcp`.** The SDK buyer/agent helpers are a later tranche.
- **`@x402/*` follows the workspace:** 2.27 until PR #22 (0016) merges, then 2.28.

## Not yet decided

- Page size and maximum for `/discovery/resources` (0032); the fake uses 20 and 50.

## Plan for the end of the task

- **Black-box end-to-end test (W209).** After PR C, an agent that has not seen the code writes
  scenarios with expected results from the tool descriptions, the README and the acceptance
  criteria only, then runs them against the built CLI over MCP: the example seller on testnet
  (settled through x402.org), fake sellers for cases a live seller cannot produce (a stalled body,
  a broken settlement header, a redirect), and the buyer's balance on Horizon after each paid
  scenario. The result is a table scenario · expected · got, with transaction hashes.
  The scenarios stay in the repo as a script run by hand (`pnpm e2e:testnet`, not in CI: it
  needs a funded testnet wallet), so the run can be repeated on our own facilitator later (W270 A).
- **One topic per file (W237, W238 A), a `[structure only]` PR after PR #23 and before PR C:**
  `server.ts` only registers the tools; `catalog.ts` holds `list_resources`; `guard.ts` the address
  guard and `guardedFetch`, shared by preview and payment; `preview.ts` holds `get_resource`;
  `pay.ts` and `results.ts` stay. Moves only, proven by unchanged tests and `moved.sh`.
- **One deadline per paid call (PR #28 devil's advocate), a fix PR after PR C:** the time limit
  applies per seller request, and a paid call makes two, so it can outlast the MCP client's 60 s
  (SDK default); the agent then sees a timeout without the transaction hash and may pay again.
  One deadline for the whole call, under 60 s. The same PR lets `allowInsecureLocal` open only
  loopback hosts, not every http host.
- **Budget per process and per day (W235 C), in the PR after PR C:** the per-process budget stays;
  a daily budget is added, kept in a local file so a restart does not reset it.
  The file is updated under a lock, since parallel sessions run parallel processes.
- **Tool schemas out of `server.ts` (W299 A), a `[structure only]` step, no PR yet:** the input and
  output schemas of `get_resource` and `call_paid_http` move to `preview.ts` and `pay.ts`, as
  `list_resources`' already live in `catalog.ts`; `server.ts` only registers.
- **Comparison with existing x402 MCP servers.** A table of `nirholas/x402-bridge` and
  `jamesbachini/x402-mcp-stellar` against ours (networks, limits and budget, error codes, address
  guard, how seller text reaches the model), so the choice of an own server stays checkable.
- **Follow-ups from the PR #23 review, for PR C:** a test that `allowInsecureLocal` is off by
  default; README notes that the budget resets on restart and that a host with both public and
  private DNS records is refused.
- **Libraries instead of own code, for PR C (W217, W219):** the private-address list becomes
  `ipaddr.js` with "only `unicast` passes"; the CLI's env parsing uses `zod`. The streamed size cap
  stays own code: undici's `maxResponseSize` counts bytes on the wire, so a 9,751-byte gzip body
  that unpacks to 10 MB passed a 100,000-byte limit (measured in the PR #28 review).

## Out of scope

- Text search (`query`), until the catalog serves `/discovery/search`.
- `call_paid_mcp_tool`: a separate task together with `examples/mcp-metered`, after `upto`
  settlement (0015).
- End-to-end on our own catalog and facilitator: possible after 0032 and 0009/0026; this task
  ends with e2e on the fake catalog and the public x402.org testnet facilitator.
