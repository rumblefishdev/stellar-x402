# Example 1: a paid HTTP API on Stellar testnet

`GET /weather?city=Warsaw` costs 0.001 testnet USDC. The route is described for the Bazaar
(`declareDiscoveryExtension`), so a facilitator that catalogs on settle lists it after the first
payment. Payments are verified and settled by the public x402.org facilitator.

A payment is verified before the route answers and settled only after it; a request without
`city` gets `400` and is not charged.

```bash
SELLER_ADDRESS=G... pnpm --filter @stellar-x402/example-http-api dev
curl -i "http://localhost:4021/weather?city=Warsaw"   # 402 with the PAYMENT-REQUIRED header
```

| Variable          | Default                            | Meaning                                                               |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `SELLER_ADDRESS`  | required                           | Stellar testnet account that receives USDC; it needs a USDC trustline |
| `FACILITATOR_URL` | `https://www.x402.org/facilitator` | facilitator that verifies and settles                                 |
| `PORT`            | `4021`                             | port to listen on                                                     |

A buyer pays it with `call_paid_http` from `stellar-x402-mcp` (`apps/mcp-local`).
