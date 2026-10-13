# stellar-x402-mcp

A local MCP server (stdio) that lets an agent browse the Stellar Bazaar and pay for x402 HTTP
resources on **Stellar testnet**, within limits you set.

| Tool             | What it does                                                                                            | Needs a key |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| `list_resources` | lists catalog entries: price, asset, network, description, how to call                                  | no          |
| `get_resource`   | asks the seller without paying and returns its terms (price, time limit, input and output)              | no          |
| `call_paid_http` | calls the resource, pays the 402 price within the limits, returns the response and the transaction hash | yes         |

Every failure comes back as a code from a fixed list (`over_price_limit`, `over_budget`,
`insufficient_funds`, `unsafe_url`, `payment_unknown`, …); causes go to stderr only.

## Build

```bash
pnpm install
pnpm --filter @stellar-x402/mcp-local... build
```

The binary is `apps/mcp-local/dist/index.js`.

## Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "stellar-x402": {
      "command": "node",
      "args": ["/absolute/path/to/stellar-x402/apps/mcp-local/dist/index.js"],
      "env": {
        "STELLAR_X402_DISCOVERY_URL": "https://your-catalog.example.com",
        "STELLAR_X402_SECRET_KEY": "S... (a testnet-only key)",
        "STELLAR_X402_MAX_PER_CALL": "10000",
        "STELLAR_X402_BUDGET": "100000"
      }
    }
  }
}
```

Without `STELLAR_X402_SECRET_KEY` the server only lists and previews.

## Settings

| Variable                            | Default             | Meaning                                                                                            |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `STELLAR_X402_DISCOVERY_URL`        | required            | base URL of a server with `GET /discovery/resources`                                               |
| `STELLAR_X402_SECRET_KEY`           | none                | the buyer's Stellar secret key; enables `call_paid_http`                                           |
| `STELLAR_X402_MAX_PER_CALL`         | required with a key | the largest price one call may pay, in atomic units (`10000` = 0.001 USDC)                         |
| `STELLAR_X402_BUDGET`               | required with a key | the most this process may spend, in atomic units                                                   |
| `STELLAR_X402_NETWORK`              | `stellar:testnet`   | anything else stops the server: it pays on testnet only                                            |
| `STELLAR_X402_TIMEOUT_MS`           | `30000`             | a tool call gives up after this long, all its requests together                                    |
| `STELLAR_X402_MAX_RESPONSE_BYTES`   | `100000`            | a seller response larger than this is refused (`response_too_large`)                               |
| `STELLAR_X402_ALLOW_INSECURE_LOCAL` | `0`                 | `1` allows `http` and local addresses — **only** for a seller you run on your own machine in tests |

## What to know

- **Use a testnet-only key** that holds only what you are willing to spend. The asset paid is
  testnet USDC; get some at <https://faucet.circle.com> (Stellar Testnet) after adding a USDC
  trustline.
- **The budget lasts until the server restarts.** Claude Desktop starts the server again each time
  it starts, so the budget starts again from zero; the key's balance is the hard limit.
- **Each server process has its own budget.** Two Claude sessions start two processes, and each may
  spend the full budget.
- **Every payment sent counts against the budget**, even one the seller refuses afterwards; a
  payment that could not be signed (for example, too little USDC) does not.
- **Sellers are reached only at public addresses over https.** A host whose DNS name points into a
  private network — even with a public certificate — is refused (`unsafe_url`), and so is a name
  with both a public and a private address.
- **`get_resource` sends a real request** without paying. On a path the seller charges for, it gets
  the 402 terms; on a path the seller does not charge for, the seller runs the request.
- The server writes logs to stderr; stdout carries the MCP protocol. The secret key never appears
  in tool output or logs; the log names only the buyer's public address.
