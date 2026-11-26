# Test seller: a paid HTTP API on Stellar testnet

The seller half of a future Example 1, started as the paid endpoint the MCP server's end-to-end
run pays. It answers a fixed temperature: it shows the payment, not a weather service. The buyer
side and the second example are still to be built.

`GET /weather?city=Warsaw` costs 0.001 testnet USDC. The route is described for the Bazaar
(`declareDiscoveryExtension`), so a facilitator that catalogs on settle lists it after the first
payment. Payments are verified and settled by the public x402.org facilitator.

A payment is verified before the route answers and settled only after it; a request without
`city` gets `400` and is not charged.

```bash
SELLER_ADDRESS=G... pnpm --filter @stellar-x402/example-http-api dev
curl -i "http://localhost:4021/weather?city=Warsaw"   # 402 with the PAYMENT-REQUIRED header
```

| Variable          | Default                            | Meaning                                                                               |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `SELLER_ADDRESS`  | required                           | Stellar testnet account that receives USDC; it needs a USDC trustline                 |
| `FACILITATOR_URL` | `https://www.x402.org/facilitator` | facilitator that verifies and settles                                                 |
| `PORT`            | `4021`                             | port to listen on; `0` lets the system pick one, named in the start line              |
| `PUBLIC_ORIGIN`   | none                               | the https origin buyers reach it at, behind a proxy; the 402 names `<origin>/weather` |

A wrong or missing setting stops the start with a message naming the variable.

Without `PUBLIC_ORIGIN` the 402 names the URL the request came in on. Behind a proxy that ends
TLS, such as a Cloudflare tunnel, that is an `http://` URL, which a catalog refuses to list: set
`PUBLIC_ORIGIN` there.

The image runs it on our server beside the facilitator (task 0042); it holds no secret:

```bash
docker build --platform linux/amd64 -f examples/http-api/Dockerfile -t x402-seller .
docker run --rm -p 4021:4021 -e SELLER_ADDRESS=G... x402-seller
```

A buyer pays it with `call_paid_http` from `stellar-x402-mcp` (`apps/mcp-local`).
