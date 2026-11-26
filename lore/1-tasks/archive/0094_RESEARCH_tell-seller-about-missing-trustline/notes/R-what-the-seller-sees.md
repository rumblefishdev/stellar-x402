---
title: "What a seller sees today when its payTo can't receive the asset"
type: research
status: mature
tags: [facilitator, sdk, payments, trustline]
links:
  - ../../../../../apps/facilitator/test/live/payto-trustline-missing.ts
  - ../../../../../apps/facilitator/test/live/results/payto-trustline-missing-testnet.json
history:
  - date: "2026-11-26"
    status: mature
    who: akot
    note: >
      Read from the 2.31.0 dists in node_modules/.pnpm and from our code, then checked on testnet
      with test/live/payto-trustline-missing.ts (run 2026-11-26 13:49 UTC, every check passed).
    spawns: [notes/S-recommendation.md]
---

# What a seller sees today when its payTo can't receive the asset

Read on 2026-11-26 from `@x402/core`, `@x402/stellar`, `@x402/express` and `@x402/fetch` 2.31.0
(the `.mjs` files in `node_modules/.pnpm`, not the `.d.ts`), and run once on testnet with
`apps/facilitator/test/live/payto-trustline-missing.ts`. Paths below are short:
`core` = `@x402+core@2.31.0/node_modules/@x402/core/dist/esm/chunk-PVRH2E6N.mjs`,
`stellar` = `@x402+stellar@2.31.0/node_modules/@x402/stellar/dist/esm/`.

## In one line

With every client we know of, the seller sees **nothing**: the client stops before it signs, so
the seller only gets an unpaid request, which looks like any visit. A payment reaches `/verify`
only from a client that doesn't simulate, or when `payTo` loses the trustline after the payment
was signed. Even then the seller's server answers the buyer a 402 with the bare reason, logs
nothing, and the account and the asset stay in the facilitator's log.

## Per client

| Client                                    | Stops where                                        | What the buyer gets                                                                                                                                    | What reaches the seller                         | Seller's log | Facilitator's log                        |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------ | ---------------------------------------- |
| MCP (`apps/mcp-local`, pays through the SDK) | upstream's simulation, before signing          | tool result `payto_trustline_missing`, naming the account and the asset; "Nothing was sent"                                                            | one unpaid request, answered 402                | nothing      | nothing: no call                         |
| Our SDK, `createPayingFetch`              | the same                                           | `PaymentError` `payto_trustline_missing`, `paid: "none"`, with `account` and `asset`                                                                    | one unpaid request, answered 402                | nothing      | nothing: no call                         |
| Upstream `@x402/fetch`                    | the same                                           | a plain `Error`: "Failed to create payment payload: Stellar trustline is missing for account G… and asset C…: HostError: Error(Contract, #13)"         | one unpaid request, answered 402                | nothing      | nothing: no call                         |
| A client that reaches `/verify`           | our `/verify`, `invalid_exact_stellar_payto_trustline_missing` | 402, body `{"error":"invalid_exact_stellar_payto_trustline_missing"}`, the same in `PAYMENT-REQUIRED`'s `error`; no account, no asset | the paid request, answered 402       | nothing      | `verified` with `isValid: false`, the reason and `message` naming the account, the asset and the ledger |

"Seller's log" is what the seller's own process wrote: in the run, its code's log and every
`console` call, which stayed empty.

## From the code

### The client stops before signing

- `ExactStellarScheme.createPaymentPayload` simulates the transfer before it signs and again after
  (`stellar/chunk-Z4D34A5C.mjs:77`, `:90`); there is no option to skip it.
- `handleSimulationResult` reads the SAC's diagnostic event "trustline entry is missing for
  account" and throws `TrustlineMissingError(account, asset, rawError)` when the account is the
  payer or `payTo` (`stellar/chunk-BGEUNRMN.mjs:98-106`). An account that doesn't exist gives the
  same event, so it is the same error (0078 decision 4; MCP e2e E-14e).
- `@x402/fetch`'s `wrapFetchWithPayment` catches it and throws
  `new Error("Failed to create payment payload: " + message)`
  (`@x402+fetch@2.31.0/.../dist/esm/index.mjs:57-62`): the type and its `account`/`asset` fields are
  lost; only the text keeps them. Our SDK reads the original from `onPaymentCreationFailure`
  (`packages/sdk/src/buyer/call.ts:218-221`, `signingFailure` `:97-133`), and MCP pays through it.
- So any client built on `@x402/stellar`'s `ExactStellarScheme` sends no payment, and the
  facilitator is never called. The seller got one unpaid `GET` from each client in the run.

### A payment that does reach `/verify`

- Our facilitator answers a refusal as a 200 with `isValid: false`, `invalidReason` and
  `invalidMessage` (`apps/facilitator/src/http/app.ts:245-298`), and logs `verified` with the
  message for the trustline reasons (`:78-83`, `:282-296`).
- `HTTPFacilitatorClient.verify` throws a `VerifyError` only for a non-2xx answer (`core:534`); a
  200 is parsed as a result, `invalidMessage` included (`core:540`).
- `x402ResourceServer.verifyPayment` hands that result to the `afterVerify` hooks
  (`core:1357` → `runAfterVerifyHooks`, `core:1887-1917`); `onVerifyFailure` runs only for a thrown
  error (`core:1358-1383`), so it never sees this refusal.
- `x402HTTPResourceServer` then answers a 402 built with `verifyResult.invalidReason` alone
  (`core:2823-2836`). `invalidMessage` goes nowhere, and nothing is logged: the file's `console`
  calls (`core:449, 1062, 1863, 1874, 2939, 3213, 3327, 3492`) are none of them on this path.
- `@x402/express` sends that 402 as it is (`@x402/express/dist/esm/index.mjs:197-204`); it logs only
  thrown errors (`:112`, `:358`).
- So the one place a seller's code can see the account and the asset is an `onAfterVerify` hook
  reading `result.invalidMessage`. Nothing in our SDK or example does it.

### What exists for the seller before the first payment

- `@stellar-x402/sdk/seller` exports `checkTrustline` (0102): two ledger reads, no signing, `ok`,
  `missing` (no trustline, not authorized, or no account) or `unknown` (a contract account, not a
  SAC, other network, no RPC answer) (`packages/sdk/src/trustline.ts`).
- `examples/http-api/src/index.ts:9-26` runs it at start for its one offer (testnet USDC): `missing`
  stops the start with what to add; `unknown` warns and starts.
- Upstream's own start check, `validateRouteConfiguration` (`core:3205`), checks schemes and the
  facilitator's `/supported`, not `payTo`. A route's `payTo` may be a function resolved per request
  (`core:1180`), so no start check can see every `payTo`.

## Which clients reach `/verify`

None we know of for this case. Every TypeScript client we found is upstream's scheme, which
simulates. The cases left:

- a client with its own Stellar code that doesn't simulate (none found);
- `payTo` loses its trustline, or is merged away, between signing and sending: seconds, in practice
  never;
- a different seller-side problem that upstream's simulation doesn't catch but our `/verify` does:
  `invalid_exact_stellar_pay_to_balance_missing` (0107), a contract `payTo` without a balance of a
  SAC token, whose message tells the seller what to send. It was signed by upstream's client and
  refused at `/verify` on testnet (`test/live/results/pay-to-balance-missing-testnet.json`,
  2026-11-24). It takes the same path as above: the buyer gets the bare reason and the seller
  nothing.

## The testnet run

`apps/facilitator/test/live/payto-trustline-missing.ts`, 2026-11-26 13:49 UTC, results in
`test/live/results/payto-trustline-missing-testnet.json`. Our facilitator built by `main()` in the
process (a fresh friendbot key, one channel, its channel setup `2a819eff…08145`), a seller with
upstream's Express middleware set up as `examples/http-api`'s `createApp`, and the e2e buyer
`GDARC6Q2…457VZ` (20.005 USDC before and after: nothing was paid).

1. `payTo` `GB6PPDEH…AXAO3G`, fresh, no trustline (`checkTrustline`: `missing`, "no trustline").
   - SDK: `PaymentError` `payto_trustline_missing`, `paid: "none"`.
   - `@x402/fetch`: `Error` "Failed to create payment payload: Stellar trustline is missing for
     account GB6PPDEH… and asset CBIELTK6…: HostError: Error(Contract, #13)".
   - The seller got two unpaid `GET`s, each answered 402 "Payment required". Its log: empty.
2. `payTo` `GDQG7WND…QFQ572H`, fresh, trustline added (`5423fc57…2a516`), `checkTrustline` `ok`; two
   payments signed by upstream's client.
   - Trustline removed (`412aee46…cdd3`; `checkTrustline`: `missing`, "no trustline"), first
     payment sent: 402, `error` `invalid_exact_stellar_payto_trustline_missing`, body the same, no
     account named.
   - Account merged away (`8ad5c17f…edb7a`; `checkTrustline`: `missing`, "the account does not
     exist"), second payment sent: the same 402 and reason.
   - The same payments sent straight to `/verify` with `HTTPFacilitatorClient`, which is what an
     `onAfterVerify` hook gets: `isValid: false`, the reason, and `invalidMessage` "this payment
     will not settle here, but its auth entry may still land in ledger 5935529: sign a new payment
     once that ledger has closed; GDQG7WND… has no USDC:GBBD47IF… trustline as of ledger 5935470:
     the account must exist and hold one".
   - Facilitator's log: four `verified` lines with that reason and `message` (two through the
     seller, two straight; the straight ones carry no `rpc`, answered from the refused record,
     0156). Seller's log: empty.

Run again at 14:23 UTC for 0164, which added a record of what its `readVerifyRefusal` reads in the
seller's `onAfterVerify` hook, kept apart from the seller's log: the same answers, 8 checks passed,
and both refusals read as `sellerMustAct` with the account in the message. Its transactions:
trustline `0fc01c17…0b527`, removed `f92da771…32b8e`, merged `0277ebed…1d474b`, channel setup
`3f0b6473…e3479`. The results file holds that run; the first one's is in commit 977abf15.

The MCP binary itself was not run here: it pays through the SDK above, and its own testnet e2e
covers the case. E-14d (`payTo` without a trustline) and E-14e (`payTo` that doesn't exist) on
2026-11-26 12:47 UTC, commit 30995a04 (`apps/mcp-local/e2e/results/testnet-results.json`): code
`payto_trustline_missing`, the seller's account and the asset named, **0 paid requests at the
seller**.
