# Test seller: a paid HTTP API on Stellar testnet

The seller half of a future Example 1, started as the paid endpoint the MCP server's end-to-end
run pays. It answers a fixed temperature: it shows the payment, not a weather service. The buyer
side and the second example are still to be built.

`GET /weather?city=Warsaw` costs 0.001 testnet USDC. The route is described for the Bazaar
(`declareDiscoveryExtension`), so a facilitator that catalogs on settle lists it after the first
payment. Payments are verified and settled by this project's facilitator, configured with
`createFacilitatorConfig` from `@stellar-x402/sdk/seller`.

Before it listens, the seller checks that `SELLER_ADDRESS` can receive testnet USDC
(`checkTrustline`, which signs nothing). Without the trustline nobody can pay it, and nothing would
say so: a buyer's client finds the missing trustline before it signs and sends nothing, so the
seller would see only unpaid requests. The start stops and says what to add. When the check can't
tell (no RPC answer), it says so and starts. After each settlement it logs the catalog's answer
(`readCatalogAnswer`): whether the facilitator took the route's listing, or refused it and why.
For each payment the facilitator refuses, it logs the reason and the facilitator's message
(`readVerifyRefusal`), and says when the fix is on the seller's side; the buyer gets the reason
alone.

A payment is verified before the route answers and settled only after it; a request without
`city` gets `400` and is not charged.

```bash
SELLER_ADDRESS=G... pnpm --filter @stellar-x402/example-http-api dev
curl -i "http://localhost:4021/weather?city=Warsaw"   # 402 with the PAYMENT-REQUIRED header
```

| Variable          | Default                                    | Meaning                                                                        |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `SELLER_ADDRESS`  | required                                   | Stellar testnet account that receives USDC; it needs a USDC trustline          |
| `FACILITATOR_URL` | `https://x402-facilitator.sorobanscan.com` | facilitator that verifies and settles                                          |
| `X402_API_KEY`    | none                                       | the facilitator's API key, sent on `/verify` and `/settle`; testnet needs none |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org`      | Stellar RPC the trustline check at start reads                                 |
| `PORT`            | `4021`                                     | port to listen on; `0` lets the system pick one, named in the start line       |

A wrong or missing setting stops the start with a message naming the variable.

A buyer pays it with `call_paid_http` from `stellar-x402-mcp` (`apps/mcp-local`).
