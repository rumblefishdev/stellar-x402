---
id: "0102"
title: "Build the TypeScript SDK helpers the RFP asks for"
type: FEATURE
status: completed
owner: akot
milestone: 2
related_adr: ["0001"]
related_tasks:
  ["0101", "0041", "0092", "0136", "0140", "0132", "0044", "0137", "0162", "0075", "0163"]
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
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      Surveyed other facilitators' SDKs and upstream 2.31 after proposing the list
      (notes/R-sdk-helper-survey.md). The list below changes in four places once its twelve
      decisions are agreed; converted to a directory for the note.
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      The twelve decisions made (akot) and the list replaced: five helpers in M2, over four PRs.
      What waits for M3 is 0163, spawned here. The owner's agreement is still open; nothing is
      built.
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      Code started before the list's agreement (akot): 0092's MCP part is #247, and PR 1, the
      buyer's helper with MCP on it, is #248, stacked on #247. 26 of 26 testnet scenarios passed
      after the move.
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      #246, #247 and #248 merged after one review round. PR 2 started: the SDK's paying fetch runs
      x402HTTPClient's calls in order, 0044's first step. pay.test.ts unchanged; testnet e2e on
      ea5ae0e4: 28 scenarios, 132 rows, none failed.
  - date: "2026-11-26"
    status: active
    who: akot
    note: >
      PR 2 (#255), PR 3 (#258) and PR 4 (#259) merged, stacked in that order. One review round:
      #258's trustline check had a time limit stellar-sdk 16.4.1 ignores, so a silent RPC held
      the example seller's start; fixed in c19c00db, the limit set on the RPC's HTTP client.
      #259's three nits left as they are (akot). Testnet e2e on 30995a04, #259's head with all
      three: 28 scenarios, 132 rows, none failed. The example seller on the production facilitator
      logged the catalog's answer, resource_not_public for a localhost route. The owner agreed to
      the helper list (reported by akot); both acceptance criteria met.
  - date: "2026-11-26"
    status: completed
    who: akot
    note: >
      Closed after #247, #248, #255, #258 and #259 (records in #263). `@stellar-x402/sdk` has
      `/buyer`, `/seller` and `/bazaar`, five helpers for the three parties the RFP names. SDK 69
      unit tests, MCP 173, the example 21; testnet e2e 28 scenarios, 132 rows, none failed. The M3
      half (validateListing, /sqlite, the buyer's core, upto, npm) is 0163.
---

# Build the TypeScript SDK helpers the RFP asks for

## Summary

The RFP asks for "SDK helpers for sellers, buyers, and agents"
(`docs/rfp/07-x402-facilitator-bazaar.md:20,121`, architecture §7).
`docs/planning/m1-epics.md:44-47` puts them outside T1. This task holds the TypeScript helpers;
the Rust seller crate is 0136 (done) and 0140. The RFP's two examples belong to 0041.

## Context

- `packages/sdk` exists, holding only the Rust crate (`packages/sdk/rust`, 0136). The TypeScript
  helpers take `packages/sdk` itself (0136 decision 1, ADR 0001).
- 0132 counts this task in M2's D4, "SDK helpers, TypeScript (0102, 0092)"; the tranche table
  puts SDK helpers in #2 and #3 (`docs/scf/milestone-1-evidence.md:129`). This task is the M2
  half and 0163 the M3 half, as 0136 and 0140 are for Rust.
- The seller's discovery metadata is upstream's `declareDiscoveryExtension` (0075), not rebuilt.
- The buyer's payment logic lives in `apps/mcp-local/src/pay.ts`, and the catalog client in
  `catalog.ts`; both move here, and MCP uses them from here.
- The survey behind the list, with each decision's reasons:
  [R-sdk-helper-survey](notes/R-sdk-helper-survey.md). **The panel review response (item D4) is
  not in the repo and was not at hand**; the list rests on the RFP, architecture §7 and what
  tasks quote from the response.

## Helper list (akot, 2026-11-25; agreed by the owner, 2026-11-26)

One package, `@stellar-x402/sdk`, with entry points `/seller`, `/buyer` and `/bazaar`, on the
published `@x402/*` `~2.31.0`. `private` in M2 as every package here, and ready to publish: it
depends on no private package of this repo. Names other than `createFacilitatorConfig` and
`createBazaarClient` are working names.

| Party         | Helper                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                              | What we drop and why                                                                                                                                                            |
| ------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller        | `createFacilitatorConfig({ apiKey?, url?, timeoutMs? })` | Upstream's `FacilitatorConfig` for our facilitator, as CDP and PayAI name theirs: the URL (one for both networks) and the API key from 0105 as `Bearer`, on `/verify` and `/settle` only.                                                                                                                                                                                                                 | A facilitator client or a middleware of our own: upstream's. `createResourceServer`: three lines nobody else ships. Reading the environment. A check for pubnet without a key.  |
| Seller        | the catalog's answer                                     | After each settlement, tells the seller whether the facilitator took the listing for cataloging (`processing`) or refused it, with its reason. Whether the route was then cataloged isn't sent back today: cataloging runs after the `/settle` answer and can still leave it out. The Rust crate does it through `on_event`; in TypeScript nothing reads it today.                                        | The discovery metadata: upstream's `declareDiscoveryExtension`. `validateListing` before the first sale: 0163.                                                                  |
| Seller, buyer | the trustline check                                      | Without signing: does this account hold the trustline to this asset. `ok`, `missing` or `unknown`. For a seller's `payTo` at start, a buyer's setup, and MCP's start.                                                                                                                                                                                                                                     | Adding the trustline (`changeTrust`): it needs XLM, which the project's buyers need not hold, and a `payTo`'s only the seller can add.                                          |
| Buyer         | the paying `fetch`                                       | Stands in for `fetch`: pays a 402 within a limit per call (required) and a daily budget (optional, with a store named by the caller), and answers upstream's `Response` with a `payment` field. Every failure is a `PaymentError` with one of ten codes and `paid` (`none`, `not_settled`, `unknown`); 0092's missing trustline is two of the codes, with the account and the asset. Moved from `pay.ts`. | Upstream's `spendControls`: its refusals carry no code. The SSRF guard and the deadline: MCP's. A SQLite store: stays in MCP (0163). The core as a public API: 0163, with 0162. |
| Agent         | `createBazaarClient({ url?, timeoutMs? })`               | `list` and `search` over upstream's `withBazaar`, with sellers' free text cut short before it reaches a model, and a deadline. Moved from `catalog.ts`; MCP's catalog tools use it.                                                                                                                                                                                                                       | Ranking of its own: the route's (0120). `searchAndPay`: binding a payment to a listing is the MCP's work.                                                                       |
| `upto`        | none in M2                                               | None.                                                                                                                                                                                                                                                                                                                                                                                                     | Deferred to 0163: published `@x402/stellar` has only `exact`, and `upto` in `/settle` is 0015 (M3), waiting on 0034.                                                            |

## Implementation

Started before the owner agreed to the list (akot, 2026-11-25), in this order:

1. 0092's MCP part, in its own branch (#247): `pay.ts` tells a missing trustline from a low balance by
   the error's type, with the two new codes. First, so that PR 1 starts from the codes in place.
2. **PR 1** (#248, after #247): the package, and the buyer's round trip moved from `pay.ts` behind
   the SDK's new API (decisions 6 and 7), with MCP on it and `pay.test.ts` as it is. Early, since
   it is on MCP's money path and MCP is in Tranche #2; the testnet e2e runs before and after.
3. **PR 2** (#255, merged 2026-11-26): 0044's first step, done here: `x402HTTPClient`'s calls in
   order instead of `wrapFetchWithPayment`, under the same tests.
4. **PR 3** (#258, on #255, merged 2026-11-26): the seller's helpers and the trustline check;
   `examples/http-api` uses them.
5. **PR 4** (#259, on #258, merged 2026-11-26): the Bazaar client, on top of #245 (0137, merged
   2026-11-25).

To agree with others: bstruzyk the list (agreed, 2026-11-26); karolkow 0044's step moving here
and the catalog tools moving onto the Bazaar client; okarcz 0092's codes and what D4's evidence
is (0132 names none).

## Acceptance Criteria

- [x] The helper list per party is recorded here, agreed with the owner
- [x] Every TypeScript SDK helper on that list exists, or the owner has dropped it in writing

## Implementation Notes

- `packages/sdk`: `/buyer` (`createPayingFetch`, `PaymentError`, `memoryBudget`, `checkTrustline`),
  `/seller` (`createFacilitatorConfig`, `FACILITATOR_URL`, `readCatalogAnswer`, `checkTrustline`)
  and `/bazaar` (`createBazaarClient`, `CatalogError`). Dependencies: `@stellar/stellar-sdk`,
  `@x402/extensions` and `zod`; `@x402/core` and `@x402/stellar` are peers. `@x402/fetch` is gone.
- MCP pays, lists and searches through it; `pay.test.ts`, `discovery.test.ts` and
  `search.test.ts` pass unchanged.
- `examples/http-api` defaults to this project's facilitator, takes `X402_API_KEY`, checks
  `payTo`'s trustline at start and logs the catalog's answer after each settlement.

## Issues Encountered

- **A dead time limit** (#258's review): stellar-sdk 16.4.1's `rpc.Server` takes `timeout` in its
  types and never reads it (17.3.0 does), so a silent RPC held `checkTrustline`, and the example
  seller's start, for minutes. Fixed by setting the limit on the server's HTTP client; a race alone
  answers in time but leaves the request, and a short script, hanging. Tests cover a silent RPC and
  one that sends headers without a body.
- **A test that checked another case**: "not a Stellar Asset Contract" was tested with no contract
  instance at all. It now has a wasm instance, and a missing contract has its own reason.
- **Stacking**: #255 and #258 both changed the SDK's dependencies, so they conflicted in
  `packages/sdk/package.json` and `pnpm-lock.yaml`. #258 was rebased onto #255 and #259 onto #258,
  and they merged in that order.

## Design Decisions

### From Plan

1. The twelve decisions of [R-sdk-helper-survey](notes/R-sdk-helper-survey.md): five helpers over
   four PRs, `private` in M2, upstream's types and middleware rather than our own, and 0044's first
   step done in the SDK.

### Emerged

2. **The trustline check's time limit on the HTTP client** (akot, #258 review): as 17.3.0 does with
   `timeout`. A `timeoutMs` that would be no limit is a `TypeError`.
3. **No check of the RPC's network** (akot, #258 review): a Stellar Asset Contract's id comes from
   the network's passphrase, so an asset of the other network reads as "no contract with this
   address on the RPC's network". Checked against live testnet and pubnet RPCs.
4. **`unknown` starts the example seller, `missing` stops it** (#258): an RPC that doesn't answer
   isn't the seller's fault.
5. **`CatalogError` has its own codes** (#259): MCP maps them to its tool codes, and a 400 on `list`
   stays `upstream_error`, as before.
6. **#259's nits left** (akot): no `timeoutMs` check in `createBazaarClient`, `offset` among the
   refusal's parameter names for search, `list_resources` reading `invalid_request` as
   `upstream_error`.

## Future Work

- The M3 half: 0163.
