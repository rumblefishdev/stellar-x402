# @stellar-x402/sdk

TypeScript helpers for paying and charging with [x402](https://www.x402.org) on Stellar, over the
published `@x402/*` packages and this repository's facilitator. The Rust crate is in
[`rust/`](rust/README.md).

Part 1 of the TypeScript SDK (task 0102). Its entry points come one per pull request:

| Entry point | For      | What it holds                                                     | State    |
| ----------- | -------- | ----------------------------------------------------------------- | -------- |
| `/buyer`    | a buyer  | `createPayingFetch`: pays a seller's 402 within limits you set    | done     |
| `/seller`   | a seller | the facilitator's config, the catalog's answer, a trustline check | done     |
| `/bazaar`   | an agent | a client to list and search the Bazaar                            | this one |

Not on npm before part 2 (task 0163). From this repository it is `@stellar-x402/sdk` in the
workspace, as the MCP server (`apps/mcp-local`) uses it.

`@x402/core` and `@x402/stellar` are peer dependencies (`~2.31.0`): install them beside it. The
schemes you pass are built from your copy, and the SDK tells a missing trustline from a low balance
by the class of the error your scheme throws, so there must be one copy of each.

## Pay for a resource

```ts
import { createPayingFetch, memoryBudget, PaymentError } from "@stellar-x402/sdk/buyer";
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const signer = createEd25519Signer(process.env.SECRET_KEY!, "stellar:testnet");

const pay = createPayingFetch({
  schemes: [{ network: "stellar:testnet", client: new ExactStellarScheme(signer) }],
  payer: signer.address,
  // In the asset's atomic units: 10000 is 0.001 USDC. An offer in any other asset is refused.
  assets: { [USDC_TESTNET_ADDRESS]: { maxPerCall: 10_000n, daily: 100_000n } },
  // A daily budget needs a store; this one is forgotten when the process exits.
  budget: memoryBudget(),
});

try {
  const response = await pay("https://api.example.com/weather?city=Warsaw");
  console.log(await response.json(), response.payment?.transaction);
} catch (error) {
  if (error instanceof PaymentError) console.log(error.code, error.paid, error.message);
  else throw error;
}
```

`pay` takes what `fetch` takes and answers the seller's `Response`. When a payment was sent for it,
the response carries `payment`: the settlement's `transaction` (null when the seller showed none),
`network`, `asset` and `amount`. An answer that needs no payment, a 404 or a 500 among them, comes
back as it is, without `payment`.

## Limits

Checked before anything is signed, in this order; the first that leaves no offer gives the code:

1. The asset is one of `assets` (`asset_not_allowed`).
2. The price is a whole number of atomic units above zero, and the seller wants the payment valid
   for at most 300 s (`unsupported_payment`).
3. The price is within `maxPerCall` (`over_price_limit`).
4. With a `daily` budget, the price fits what is left of the UTC day (`over_budget`). It is counted
   when the offer is chosen, and given back only when nothing was signed or sent.

`maxPerCall` is required for each asset. `daily` is optional; with one, `budget` is required, or
`createPayingFetch` throws when it is made. `memoryBudget()` keeps one process's spending; a store
of your own (`BudgetStore`: `count` and `giveBack`) can keep it across processes, as the MCP server
does in SQLite.

Upstream's own spend controls (`spendControls`) are off: these limits are in atomic units per
asset, and name why they refused.

## Errors

A payment that is refused or fails is a `PaymentError`. Branch on `code`; `message` is this
library's own text, and what a seller or another library wrote is in `cause` only.

| `code`                    | When                                                                                                             | `paid`        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| `asset_not_allowed`       | no offer is in one of `assets`                                                                                   | `none`        |
| `unsupported_payment`     | no offer with a price above zero and valid for at most 300 s, or none the schemes can pay                        | `none`        |
| `over_price_limit`        | every offer left costs more than `maxPerCall`                                                                    | `none`        |
| `over_budget`             | the offer would pass what is left of the day                                                                     | `none`        |
| `insufficient_funds`      | signing fails: the payer holds the trustline and too little of the asset                                         | `none`        |
| `payer_trustline_missing` | signing fails: the payer has no trustline to the asset; the seller's account was not checked                     | `none`        |
| `payto_trustline_missing` | signing fails: the seller's `payTo` has no trustline to the asset, or does not exist; only the seller can add it | `none`        |
| `payment_failed`          | signing fails for another reason, or the budget store cannot be read or written                                  | `none`        |
| `payment_rejected`        | after the payment was sent: the seller or its facilitator says it did not settle                                 | `not_settled` |
| `payment_unknown`         | after the payment was sent, anything else goes wrong                                                             | `unknown`     |

`paid` says whether money may have moved. `none`: nothing was signed or sent, and an amount
already counted went back to the budget (the four refusals up to `over_budget` counted nothing).
`not_settled` and `unknown`: the signed payment left this process and counts as spent, since it
stays valid until it expires; do not pay again for the same thing without checking. The
two trustline codes also carry the `account` without the trustline and the `asset`.

A missing trustline is found before anything is signed: `@x402/stellar` simulates the payment
first. The SDK reports it and does not add the trustline: that takes XLM for the reserve and the
fee, and a seller's only the seller can add. The message names USDC as `CODE:ISSUER` too, as
`changeTrust` takes it; other assets by their contract. A muxed `payTo` (`M…`) is
`payment_failed`: the asset contract names the underlying `G…` account, which `@x402/stellar`
doesn't match to it.

A failure of the underlying `fetch` before any payment was sent is thrown as it is, not as a
`PaymentError`.

## Options

| Option    | Meaning                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `schemes` | scheme clients holding the buyer's key, such as `ExactStellarScheme` for a network                                      |
| `payer`   | the buyer's public address, the one those schemes sign for; it keys the budget                                          |
| `assets`  | per asset contract: `maxPerCall` and an optional `daily`, in atomic units                                               |
| `budget`  | where the day's spending is kept; required with a `daily`                                                               |
| `fetch`   | the fetch every request goes through, the unpaid one and the paid retry; pass a guarded one for URLs you did not choose |
| `now`     | the clock that decides the day                                                                                          |

A request's `signal` is honored before the payment leaves: a payment signed after it aborted is not
sent, its amount goes back, and the signal's reason is thrown.

## Sell a resource

`/seller` holds three small things around upstream's own server (`@x402/express`,
`x402ResourceServer`); [`examples/http-api`](../../examples/http-api) uses all three.

```ts
import {
  checkTrustline,
  createFacilitatorConfig,
  readCatalogAnswer,
} from "@stellar-x402/sdk/seller";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";

const payTo = process.env.SELLER_ADDRESS!;
const trustline = await checkTrustline({
  account: payTo,
  asset: USDC_TESTNET_ADDRESS,
  network: "stellar:testnet",
});
if (trustline.status === "missing")
  throw new Error(`payTo can't receive USDC: ${trustline.reason}`);

const facilitator = new HTTPFacilitatorClient(
  createFacilitatorConfig({ apiKey: process.env.X402_API_KEY }),
);
const resourceServer = new x402ResourceServer(facilitator);
resourceServer.onAfterSettle(async ({ result }) => {
  const answer = readCatalogAnswer(result);
  if (answer.status === "rejected") console.warn(`not listed in the Bazaar: ${answer.reason}`);
});
```

- **`createFacilitatorConfig({ apiKey?, url?, timeoutMs? })`** returns upstream's
  `FacilitatorConfig` for this project's facilitator (`FACILITATOR_URL`,
  `https://x402-facilitator.sorobanscan.com`, both networks). The key, from the portal, goes as
  `Authorization: Bearer` on `/verify` and `/settle` only; pubnet requires one, testnet none. The
  library reads no environment variable, and doesn't know the network, so a missing key on pubnet
  shows at the first payment, as a 401.
- **`readCatalogAnswer(result)`** reads the facilitator's answer about the route's Bazaar listing
  from a settlement: `processing` (taken for cataloging), `rejected` with its `reason`, or `none`.
  Whether the route was then cataloged isn't sent back: cataloging runs after the settlement's
  answer.
- **`checkTrustline({ account, asset, network, rpcUrl?, timeoutMs? })`** says, without signing,
  whether an account can receive an asset: `ok`, `missing` (no trustline, one not authorized, or
  no account) or `unknown` (a contract account, a token that is not a Stellar Asset Contract or
  not on the RPC's network, or no answer from the RPC within `timeoutMs`, 10 s per request by
  default), with `reason` and the asset as `changeTrust` takes it (`classicAsset`). Nothing the RPC
  does makes it throw, so you decide whether to stop; a `timeoutMs` that is not a whole number
  above zero is a `TypeError`. Testnet has a default RPC; pubnet needs `rpcUrl`.
  `/buyer` exports it too, for a buyer's setup.

## Read the Bazaar

`/bazaar` reads a facilitator's catalog of paid resources, over upstream's `withBazaar`. The MCP
server's `list_resources` and `search_resources` tools use it.

```ts
import { CatalogError, createBazaarClient } from "@stellar-x402/sdk/bazaar";

const bazaar = createBazaarClient(); // this project's facilitator; { url, timeoutMs } to change
const { items, pagination } = await bazaar.search({ query: "weather in Warsaw", limit: 5 });
for (const item of items) console.log(item.resource, item.accepts[0]?.amount, item.description);
```

It adds two things to upstream's client:

- **The sellers' text is cut short.** The catalog is written by sellers, so `description` and
  `serviceName` are cut to 500 characters (`DESCRIPTION_CHARS`) and only the payment terms one
  chooses by stay in `accepts`. All of it is still the seller's text: data, never instructions, for
  a model that reads it.
- **A time limit** (`timeoutMs`, 10 s by default), which upstream's client has no way to take.

`list(query?)` answers a page with `pagination.total`; `search(query)` answers the best match
first, `partialResults`, and a `pagination.cursor` to pass back for the next page. A failure is a
`CatalogError`: `unavailable` (no answer, an error status, an answer in another shape, or none in
time), `invalid_request` (the catalog refused the query, naming the parameter in `param` when it is
one of the query's), or `invalid_cursor` (search again without the cursor).
