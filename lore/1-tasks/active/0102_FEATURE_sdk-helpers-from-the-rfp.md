---
id: "0102"
title: "Build the TypeScript SDK helpers the RFP asks for"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: ["0001"]
related_tasks: ["0101", "0041", "0092", "0136", "0140", "0132"]
tags: [sdk, priority-medium, effort-medium, dev-tools]
links: []
history:
  - date: "2026-11-03"
    status: backlog
    who: karolkow
    note: >
      The RFP requires SDK helpers and two examples, and no task built them; only an empty package
      stood for them until 0101 removes it.
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      Started. First step is the helper list per party (seller, buyer, agent), agreed with the
      owner before any package code; 0092 follows for the buyer helper's missing-trustline error.
---

# Build the TypeScript SDK helpers the RFP asks for

## Summary

The RFP asks for "SDK helpers for sellers, buyers, and agents"
(`docs/rfp/07-x402-facilitator-bazaar.md:20,121`, architecture §7).
`docs/planning/m1-epics.md:44-47` puts them outside T1. This task holds the TypeScript helpers;
the Rust seller crate is 0136 (done) and 0140. The RFP's two examples belong to 0041.

## Context

- `packages/sdk` exists, holding only the Rust crate (`packages/sdk/rust`, 0136). Per 0136's
  decision 1, the TypeScript helpers take `packages/sdk` itself or a folder next to `rust`.
- 0132 counts this task in M2's D4, "SDK helpers, TypeScript (0102, 0092)".
- Already covered elsewhere, so not to be rebuilt: the seller's discovery metadata
  (upstream's `declareDiscoveryExtension`, used in `examples/http-api`, see 0075).
- The buyer's payment logic lives in `apps/mcp-local/src/pay.ts` (limits, budget, the
  `onPaymentCreationFailure` hook); a buyer helper may move it out of the app instead of copying it.
- 0092 adds a missing-trustline error to the first buyer helper.

## Implementation

- Read the RFP's list with the owner first and write down here which helpers, for which party
  (seller, buyer, agent), and which are dropped. Too thin to start before that.
- Create the TypeScript package with its first helper.

## Helper list (proposed 2026-11-25, waiting for the owner)

Proposed by akot from the RFP (`docs/rfp/07-x402-facilitator-bazaar.md:20,68,121`) and
architecture §7: "thin ergonomic wrappers over the facilitator, Bazaar, and `upto`", following
the `@x402/stellar` conventions. **The panel review response (item D4) is not in the repo and was
not at hand, so this list rests on the RFP alone**; check it against D4 once someone has it.

One package, `@stellar-x402/sdk`, in `packages/sdk` itself next to `rust/` (0136 decision 1,
ADR 0001), with entry points `/seller`, `/buyer` and `/bazaar`, on the published `@x402/*`
`~2.31.0`. Every helper wraps upstream; none reimplements a scheme or a route.

| Party  | Helper                                              | What it does | What we drop and why |
| ------ | --------------------------------------------------- | ------------ | -------------------- |
| Seller | `createFacilitatorClient({ network, apiKey?, url? })` | Upstream's `HTTPFacilitatorClient` pointed at our facilitator for the network, sending `Authorization: Bearer <apiKey>` on `/verify` and `/settle` through `createAuthHeaders` (pubnet needs a key since 0105; testnet ignores it). A pubnet client without a key fails when it is made, not at the first payment. | Our own facilitator client: upstream's already speaks the routes. |
| Seller | `createResourceServer({ facilitator, networks })`   | Upstream's `x402ResourceServer` with `ExactStellarScheme` registered for each network and `bazaarResourceServerExtension`, as `examples/http-api/src/app.ts` builds it by hand; the seller passes it to upstream's `paymentMiddleware` (`@x402/express`, `@x402/hono`, `@x402/next`). | A middleware of our own per framework: upstream's all take a resource server. The discovery metadata: upstream's `declareDiscoveryExtension` (0075). |
| Buyer  | `createPaymentFetch({ schemes, payer, assets, budget?, maxAuthorizationSeconds?, fetch? })` | Upstream's `wrapFetchWithPayment` with the policy moved out of `apps/mcp-local/src/pay.ts`, not copied: allowed assets, a price above zero, an authorization of at most 300 s, a limit per call, and a daily budget counted before signing and given back when signing fails. Refusals are a typed error carrying pay.ts's codes (`asset_not_allowed`, `over_price_limit`, `over_budget`, `unsupported_payment`). It keeps the original signing error from `onPaymentCreationFailure`, so 0092's `TrustlineMissingError` (account, asset, payer or `payTo`) reaches the caller instead of the fetch's rewrapped `Error`. `fetch` is a parameter, so MCP passes its `guardedFetch`; MCP's `callPaidHttp` is rebuilt on this helper. | The SSRF guard and the call's deadline: they stay in `@stellar-x402/seller-fetch` and MCP, which fetch URLs read from a catalog. The signer: upstream's `createEd25519Signer`. A SQLite budget inside the SDK: decision B. |
| Buyer  | `readSettlement(response, payment)`                 | The checks after the paid call, moved from pay.ts: a second 402 or `success: false` is a refused payment, a transaction is shown only when it is a 64-hex hash, and an error status without one is a payment of unknown outcome. | Reading `PAYMENT-RESPONSE` itself: upstream's `x402HTTPClient.getPaymentSettleResponse`. |
| Agent  | `createBazaarClient({ network?, url?, timeoutMs? })` with `list(filters)` and `search(query, filters)` | Upstream's `withBazaar(...).extensions.bazaar` pointed at our `/discovery/resources` and `/discovery/search`, its answer checked against a schema (as `catalog.ts` does: "never trust its shape"), a deadline since upstream takes no abort signal, and a refused cursor as its own error (0137). MCP's `catalog.ts` moves onto it. | Ranking or filtering of its own: the route's (0120). A "search and pay" helper: an agent is this client plus `createPaymentFetch`, and its tool interface is the MCP server (0037). |
| `upto` | none in M2                                          | None.        | Deferred, decision C: `upto` in `/settle` is 0015 (M3), which waits for upstream to accept the spec (0034), so a helper over it could not be tested end to end in M2. |

The Rust side is 0136 (done) and 0140, not this task.

## Decisions to confirm

- **A. Place and name**: `packages/sdk` itself as `@stellar-x402/sdk`, one package with three
  entry points rather than three packages, so a seller who also buys installs one thing.
- **B. The daily budget**: the buyer helper takes a budget store (count, give back) and ships one
  in memory; MCP's SQLite store (`apps/mcp-local/src/daily.ts`, `node:sqlite`) stays in the app as
  one implementation. Built into the SDK, it would tie every buyer to Node 22.5+ and a directory
  on disk.
- **C. `upto`**: deferred to M3, with a backlog task spawned next to 0015 once this list is agreed,
  or dropped from the SDK in writing. Proposed: deferred.
- **D. Missing trustline (open, from 0092)**: does the SDK offer to add the trustline, or only
  report it? Proposed: only report: the error names the account, the asset, whose it is (the
  payer or the `payTo`) and the step to take (a `changeTrust` from that account, 0.5 XLM of
  reserve). Adding it would sign a classic transaction with the buyer's key outside the payment,
  which the helper's limits don't cover, and a missing `payTo` trustline only the seller can add.
  A helper that builds the `changeTrust` without sending it can follow if an example needs it.

## Acceptance Criteria

- [ ] The helper list per party is recorded here, agreed with the owner
- [ ] Every TypeScript SDK helper on that list exists, or the owner has dropped it in writing
