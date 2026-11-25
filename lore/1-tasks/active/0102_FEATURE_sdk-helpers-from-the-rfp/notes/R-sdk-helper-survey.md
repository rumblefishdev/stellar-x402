---
title: "What x402 SDKs ship as helpers on 2026-11-25, and what ours has to be"
type: research
status: mature
spawns: []
tags: [sdk, typescript, seller, buyer, bazaar, survey]
links:
  - https://registry.npmjs.org/@coinbase/x402
  - https://registry.npmjs.org/@payai/facilitator
  - https://github.com/thirdweb-dev/js/tree/main/packages/thirdweb/src/x402
  - https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator
  - https://github.com/tolgayayci/rail402
  - https://docs.rail402.dev
  - https://developers.stellar.org/docs/build/agentic-payments/x402
  - https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide
  - https://github.com/x402-foundation/x402/issues/3703
  - https://github.com/x402-foundation/x402/issues/2394
  - https://github.com/x402-foundation/x402/pull/3630
  - https://github.com/x402-foundation/x402/pull/3859
history:
  - date: "2026-11-25"
    status: developing
    who: akot
    note: >
      Survey of other facilitators' SDKs and of upstream 2.31, read against this repo's code and
      tasks. The twelve decisions below are open: none is agreed with the owner yet.
  - date: "2026-11-25"
    status: mature
    who: akot
    note: >
      All twelve decided (akot), each after trying to argue against it. The list in the task's
      README follows them. The owner's agreement to that list is the task's first criterion and
      still open.
---

# What x402 SDKs ship as helpers on 2026-11-25, and what ours has to be

## Result

The list first proposed in PR #246 changed in four places:

1. **Seller**: the facilitator's config, named as CDP and PayAI name it, without the `network`
   parameter (one URL serves both networks) and without `createResourceServer`. Two small helpers
   are added: the catalog's answer after a settlement, and a trustline check for `payTo`.
2. **Buyer**: not a wrapper over `wrapFetchWithPayment`. 0044, 0162 and an open upstream issue all
   point to a client made per call, with the `fetch` as a thin layer on it.
3. **Trustline**: keeping upstream's `TrustlineMissingError` meets the panel review's promise as
   written, so the SDK only reports.
4. **Scope**: the tranche table puts SDK helpers in #2 and #3, so M2 holds five helpers and 0163
   the rest.

"Decisions" holds what was decided on each of the twelve points and why (akot, 2026-11-25). The
list that follows from them is in the task's README: five helpers in M2, the rest in 0163.

## How this was checked

- Read here: this repo's code and tasks, and `@x402/*` 2.31.0 in `node_modules`.
- Read on the web on 2026-11-25, from npm typings, sources and docs: the other SDKs, Rail402
  (`@rail402.dev/sdk` 0.5.7) and the Stellar docs.
- Nothing was installed or run against our facilitator.

## What the project has promised

- The product is the marketplace: facilitator, Bazaar and MCP server. The SDK supports it:
  "thin ergonomic wrappers over the facilitator, Bazaar, and `upto` scheme, following the existing
  `@x402/stellar` ecosystem conventions" (architecture §7), and "UX enabling developers to deploy
  discoverable endpoints in under an hour" (`docs/rfp/07-x402-facilitator-bazaar.md:97-98`).
- Deliverable: "SDK helpers for sellers, buyers, and agents" (`07:121`).
- The panel review response, §5, as 0078 quotes it: "Our pre-flight simulation step detects a
  missing trustline before payment is attempted and returns an actionable error."
  `docs/scf/milestone-1-evidence.md:270-271` leaves the buyer's side of it to "a later tranche
  (SDK helpers)".
- Tranches (`milestone-1-evidence.md:129,133`): SDK helpers in #2 and #3, example integrations
  (0041) in #3.
- 0132 defines no evidence for D4 and has no row for it; that is to agree with okarcz.
- The response itself is not in the repo. Its budget line for D4 was not found; D5, the Rust crate,
  had 1.0 dev-week.

## What others ship

| SDK                          | Seller                                                               | Buyer                                                                         | Agent, catalog                           |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `@coinbase/x402` 2.1.0       | `facilitator`, `createFacilitatorConfig(keyId?, keySecret?)`         | none                                                                          | none                                     |
| `@payai/facilitator` 2.4.6   | the same two names                                                   | none                                                                          | none                                     |
| thirdweb                     | `facilitator({...})`, `settlePayment`, `verifyPayment`               | `wrapFetchWithPayment` with `maxValue`                                        | none                                     |
| OpenZeppelin (Stellar)       | no SDK: the `Bearer` header is written by hand                       | upstream's                                                                    | none                                     |
| `@rail402.dev/sdk` (Stellar) | `/seller`: `httpRoute`, `exact`, `upto`, `validateListing`           | `createBuyer().pay()`, caps per call and per 24 h, `PaymentError`, `/sqlite`  | `/discovery`, `searchAndPay`             |
| upstream 2.31                | middleware, `declareDiscoveryExtension`                              | `spendControls`, policies, hooks                                              | `withBazaar().listResources()`, `search` |

- A facilitator's SDK is small: a URL and `createAuthHeaders`, the rest left to upstream.
- The spend limit is one cap per payment nearly everywhere. A budget over time, errors with a
  stable code and a "was I charged" state are Rail402's only, and `apps/mcp-local/src/pay.ts`
  already has all three.
- Entry points per party (`/seller`, `/client`, `/discovery`) are common.
- A trustline check before paying: Rail402 only (`preflightFunds`, and `addTrustline`). Stellar's
  docs send the reader to Stellar Lab; of `PAY_TO` they say "Without it, you cannot receive
  payments."

Rail402 is the closest and much wider: 34 `payment_*` codes, a ledger of 19 methods, an `upto`
contract of its own. Apache-2.0, 2 stars, about 1,065 downloads of the SDK in the last month, listed
in Stellar's docs as a community facilitator. Its buyer is a closed object, not a configured
upstream client.

## Upstream 2.31

- `x402Client.fromConfig({ schemes, policies, spendControls })`. `spendControls` allows the default
  assets with a cap of `$1` per payment; `pay.ts:95` turns it off and applies its own policy.
- Every refusal is a plain `Error` with a message: "All payment requirements were filtered out by
  policies…", "Payment creation aborted: <reason>". `@x402/fetch` wraps what it gets as
  `Error("Failed to create payment payload: …")` (issue #2394, open).
- Issue #3703, open: hooks can't tell one call's before, after and failure from another's, so a
  budget on a shared client can't be right. `pay.ts` makes one client per call for that reason.
- PR #3630, open: a cap on `maxTimeoutSeconds`, which `pay.ts` already has (300 s).
- `@x402/stellar` exports `TrustlineMissingError` (`account`, `asset`), `InsufficientBalanceError`,
  `createEd25519Signer`, the USDC addresses, and only the `exact` scheme.
- `wrapMCPClientWithPayment(mcpClient, paymentClient: x402Client)`: limits set on a client hold for
  paid MCP tools too.
- `FacilitatorConfig.createAuthHeaders` answers per path (`verify`, `settle`, `supported`,
  `bazaar`); a flat headers object throws.

## What this repo fixes

- **0044**, first step: "drop `wrapFetchWithPayment`" in `pay.ts` and call `x402HTTPClient` in
  order. A buyer helper over the wrapper would be rewritten by it.
- **0162**: paid MCP tools under the same limits as `call_paid_http`, through
  `wrapMCPClientWithPayment`.
- **0137** (active, karolkow): the MCP's search tool over `withBazaar().search()`, with its own
  error codes.
- **0092**: the error names the account and the asset, the payer's and the `payTo`'s.
- **The Rust crate** (0136): no facilitator URL in the library, only in its example
  (`https://x402-facilitator.sorobanscan.com`, one for both networks); the key through
  `with_api_key`, sent to `/verify` and `/settle` only; pubnet without a key is not checked; no
  trustline check. Its parity is with `@x402/express`, not with these helpers.
- Every package here is `private`; the repo needs Node 22.13 or newer.

## Decisions

All decided by akot on 2026-11-25; the owner's agreement to the resulting list is still open.

1. **How much**, decided (akot, 2026-11-25): a thin package of five helpers in M2, at least one
   for each party the RFP names: the facilitator's config, the catalog's answer and the trustline
   check for the seller, the paying `fetch` for the buyer, the Bazaar client for the agent. Each
   wraps upstream or moves code that runs in MCP today; none implements the protocol.
2. **Seller's name and shape**, decided (akot, 2026-11-25):
   - One function, `createFacilitatorConfig({ apiKey?, url?, timeoutMs? })`, returning upstream's
     `FacilitatorConfig` for `new HTTPFacilitatorClient(...)`. No `network`.
   - A constant with `https://x402-facilitator.sorobanscan.com`, the production name for both
     networks (ADR 0011; its `/supported` answered `exact` on `stellar:testnet` only on
     2026-11-25). `url` replaces it for staging or a facilitator run by someone else.
   - The key goes to `/verify` and `/settle` only, as in the Rust crate.
   - The library reads no environment variable; `X402_API_KEY` is the examples' name, as in Rust.
     So no ready `facilitator` constant as CDP's: without a key `createFacilitatorConfig()` is
     the same.
   - No check for pubnet without a key: the config doesn't know the network, and the Rust crate
     doesn't check either. A wrong key shows at the first buyer, as a 401. The facilitator has no
     route to try a key without a payment; that is outside this task.
   - No `createResourceServer`.
   - Seen here: `examples/http-api` defaults to `https://www.x402.org/facilitator`, the Rust
     example to ours.
3. **Something of ours for the seller**, decided (akot, 2026-11-25), two small things in M2:
   - The trustline check of decision 8, for `payTo` at start. It answers `ok`, `missing` or
     `unknown` and doesn't throw; `unknown` is a `payTo` that is a contract, or a token that is
     not a classic asset. The seller decides whether to stop.
   - The catalog's answer, read for the seller after each settlement: listed, or refused with one
     of the eight reasons the facilitator sends in `EXTENSION-RESPONSES`. The Rust crate gives it
     through `on_event`; in TypeScript it is in the settle response and `examples/http-api` reads
     it nowhere, so a seller can sell without knowing it isn't listed. This is the M2 answer to
     "seller-side helpers for discovery metadata" (`07:68`) and needs nothing from the private
     `@stellar-x402/bazaar`.
   - `validateListing`, the check before the first sale, in M3 with the guide (0075); it waits for
     decision 11.
   - To confirm when building: that upstream's hook after settling gets `extensionResponses` (the
     field is in the response's type; the hook wasn't read), and how the trustline is looked up
     (upstream has a default Horizon URL for both networks, a default RPC URL for testnet only).
4. **The buyer's build**, decided (akot, 2026-11-25): a core that gives a configured client per
   call (limits, budget, the call's state), and a `fetch` over it. In M2 only the `fetch` is
   public; the core is exported when 0162 starts, so no API is fixed before anyone uses it. Our own
   policy stays, since upstream's refusals carry no code. Dropped: a helper that configures the
   caller's shared client, which can't keep a budget or a code right (upstream #3703).
5. **Order with 0044**, decided (akot, 2026-11-25): two PRs in this task. The first moves
   `pay.ts`'s logic into the SDK unchanged, with MCP on it and `pay.test.ts` as it is; the second
   does 0044's first step there, on `x402HTTPClient`, under the same tests. 0044 has no owner, so
   karolkow (its author) and bstruzyk (the lane) are asked, and 0044 gets a line saying the step
   moved here.
6. **Errors and the result**, decided (akot, 2026-11-25):
   - Success is upstream's `Response` with a `payment` field (`transaction`, `network`, `asset`,
     `amount`), so the helper stands in for `fetch`. The checks after paying read the status and
     the headers only, so the body is left unread. `readSettlement` goes.
   - Ten codes. Eight keep their names from `apps/mcp-local/src/results.ts`:
     `unsupported_payment`, `asset_not_allowed`, `over_price_limit`, `over_budget`,
     `insufficient_funds`, `payment_failed`, `payment_rejected`, `payment_unknown`. Two are new,
     named as the facilitator's refusals in `trustline.ts`: `payer_trustline_missing` and
     `payto_trustline_missing`. The other five stay MCP's: without a payment, a 404 or a 500 is a
     plain `Response` here.
   - `paid` on the error: `none` (nothing signed or sent, the amount goes back), `not_settled`
     (`payment_rejected`: sent, and the seller says it did not settle) and `unknown`
     (`payment_unknown`). `not_settled` still counts as spent: the signed authorization stays valid
     for up to 300 s, so the seller's word can't return it to the budget.
   - One class, `PaymentError`: `code`, `paid`, `cause` (upstream's error), and `account` and
     `asset` on the two trustline codes. `message` is our fixed text; what a seller or a library
     wrote goes to `cause` only. No subclasses, no `retryable`.
   - Beside this task: architecture §5 names "expired authorization" as a failure an agent tells
     by its code, and MCP has no code for it (it reads as `payment_rejected`).
7. **Budget**, decided (akot, 2026-11-25):
   - A store of two calls, count within the limit and give back; both may be asynchronous, since
     going from one to the other later would break callers.
   - The window is the UTC day, as in `daily.ts`. "Given back only when nothing was signed" stays.
   - `maxPerCall` is required for each asset, with no default. `daily` is optional here: 0075 sends
     an agent with a wallet to the MCP server, which still requires both, and "a client paying
     from code" needs the cap per call first.
   - No store by default. `daily` without a store is refused when the helper is made, since a
     script run again and again would start each day from zero in memory. The store in memory is
     named by the caller.
   - SQLite stays in MCP for M2, passed in through the store; `/sqlite` is decided in M3 with the
     examples (0041). The buyer who needs a budget across processes is the agent, and MCP has it;
     a spend ledger wraps none of the facilitator, the Bazaar or `upto` (§7); and `node:sqlite`
     may still be experimental on Node 22 (not checked).
8. **Trustline (0092)**, decided (akot, 2026-11-25):
   - Only report: no `changeTrust`. Upstream simulates before it signs, so its
     `TrustlineMissingError`, kept, is the panel review's "pre-flight simulation step"; it and
     `InsufficientBalanceError` carry `account` and `asset`. "Buyers never need to hold XLM"
     (architecture §3.2), and adding a trustline needs XLM for the reserve and the fee, so a helper
     that adds one would fail for the buyers the project describes.
   - The message names the account and the asset. For the payer it says to add the trustline and
     that `payTo` wasn't checked, as the facilitator's does; for `payTo` it says the seller's
     account can't receive the asset.
   - One exported check, without signing: does this account hold the trustline to this asset. The
     seller's check at start (decision 3) needs it anyway; a buyer's setup and MCP's start can use
     it, so an agent isn't stopped at its first payment.
   - 0092's MCP part (the type of `signingError`, not the `#10|#13` regex) goes before this
     task's first PR, so that PR stays a move.

Seen while deciding 7 and 8: the MCP server is in Tranche #2 and this task moves code on its money
path during M2. The first PR is early and a move only, with the testnet e2e run before and after.
9. **Agent**, decided (akot, 2026-11-25):
   - `createBazaarClient({ url?, timeoutMs? })` with `list` and `search`, moved from `catalog.ts`.
     It answers with the trimmed entries MCP gives an agent today, and has a deadline; MCP's
     catalog tools, 0137's search among them, move onto it.
   - What it adds to upstream, where
     `withBazaar(new HTTPFacilitatorClient(createFacilitatorConfig())).extensions.bazaar` already
     lists and searches: the catalog is written by sellers, so their free text is cut short
     before it reaches a model; and a deadline, since `listResources` takes no abort signal.
     Checking the answer's shape is the weaker reason: an SDK user trusts our facilitator here as
     at `/verify`.
   - In M2, as this task's last PR, after karolkow's #245 (0137) merges: it only reads, and with
     it D4 shows all three parties the RFP names.
   - No `searchAndPay`: Rail402's binds the payment to the listing's price and owner, which is
     the MCP's work here.
10. **`upto`**, decided (akot, 2026-11-25): deferred to 0163. Published `@x402/stellar` has only
    `exact`, and `upto` in `/settle` is 0015 (M3), waiting on 0034. For okarcz and 0034: Rail402's
    author has an open upstream PR with a Stellar `upto` (#3859) next to our spec (#3781).
11. **Publishing**, decided (akot, 2026-11-25):
    - `private` in M2, as every package here: nothing in this repo is on npm, the MCP server is
      installed from a checkout, and the Rust crate went into Tranche #2 with `publish = false`.
      MCP and the examples use it through the workspace. npm in M3, with the guide (0075) and the
      Rust crate (0140).
    - Ready to publish already in M2: it depends only on the published `@x402/*` and
      `@stellar/stellar-sdk`, on no private package of this repo.
    - The two small values it needs from the private `@stellar-x402/bazaar` (the description's
      length and the refusal reasons) are copied, and a test holds the copy equal.
    - `validateListing` needs `bazaar`'s code itself; how is decided in M3.
    - If okarcz finds D4's evidence needs a package one can install, a `0.x` prerelease on npm in
      M2 is the other way: npm can't install a package from a repo's subfolder over git.
    - Not checked: who holds the `@stellar-x402` scope on npm.
12. **M2 and M3**, decided (akot, 2026-11-25):
    - M2, in order: 0092's MCP part; PR 1, the package and the buyer's move; PR 2, 0044's first
      step; PR 3, the seller's helpers and the trustline check; PR 4, the Bazaar client after #245.
    - M3 is 0163, spawned from this task as 0140 was from 0136: `validateListing`, whether SQLite
      becomes `/sqlite`, the buyer's core as a public API (with 0162), the `upto` helpers, and
      npm. So this task can close in M2 on its own list.
    - Still open outside these decisions: what D4's evidence is (0132 names none), and the
      response's budget for D4, to hold four PRs against.

## Not checked

- Whether upstream's `spendControls` recognises Stellar USDC as a default asset in practice.
- How Rail402's `validateListing` compares with `packages/bazaar/src/validate.ts`.
- Mogami, Daydreams, Questflow and the other facilitators outside the table.
