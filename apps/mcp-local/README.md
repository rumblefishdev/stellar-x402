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
        "STELLAR_X402_DAILY_BUDGET": "100000"
      }
    }
  }
}
```

Without `STELLAR_X402_SECRET_KEY` the server only lists and previews.

## Settings

| Variable                            | Default                | Meaning                                                                                                 |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `STELLAR_X402_DISCOVERY_URL`        | required               | base URL of a server with `GET /discovery/resources`                                                    |
| `STELLAR_X402_SECRET_KEY`           | none                   | the buyer's Stellar secret key; enables `call_paid_http`                                                |
| `STELLAR_X402_MAX_PER_CALL`         | required with a key    | the largest price one call may pay, in atomic units (`10000` = 0.001 USDC)                              |
| `STELLAR_X402_DAILY_BUDGET`         | required with a key    | the most one key may spend in one UTC day, all its processes together, in atomic units                  |
| `STELLAR_X402_STATE_DIR`            | `~/.stellar-x402-mcp/` | where the daily budget logs what was spent, one file per UTC day; only with `STELLAR_X402_DAILY_BUDGET` |
| `STELLAR_X402_NETWORK`              | `stellar:testnet`      | anything else stops the server: it pays on testnet only                                                 |
| `STELLAR_X402_TIMEOUT_MS`           | `30000`                | a tool call gives up after this long, all its requests together                                         |
| `STELLAR_X402_MAX_RESPONSE_BYTES`   | `100000`               | a seller response larger than this is refused (`response_too_large`)                                    |
| `STELLAR_X402_ALLOW_INSECURE_LOCAL` | `0`                    | `1` also allows `http` to this machine only (below) — **only** for a seller you run on it in tests      |

## What to know

- **Use a testnet-only key** that holds only what you are willing to spend. The asset paid is
  testnet USDC; get some at <https://faucet.circle.com> (Stellar Testnet) after adding a USDC
  trustline.
- **Any program running under your user can read the key**, other MCP servers in the same client
  config included: it sits in plain text there. Keep only a small amount on it; a keychain or an
  external signer is planned before mainnet.
- **Two limits, as on a payment card:** `STELLAR_X402_MAX_PER_CALL` for one payment and
  `STELLAR_X402_DAILY_BUDGET` for one day. `STELLAR_X402_BUDGET`, a budget per server process,
  was replaced by the daily budget; a server started with it stops and says so.
- **The daily budget survives restarts and is shared.** Every process paying from the same key and
  using the same `STELLAR_X402_STATE_DIR` counts against one amount per day; the day is the UTC
  date, so it starts again at midnight UTC. Each day is its own file, `spent-YYYY-MM-DD.jsonl`, with
  one line per payment; files older than seven days are deleted. If today's file cannot be read, the
  server refuses to pay (`payment_failed`) rather than guess. `STELLAR_X402_STATE_FILE`, a single
  file, was replaced by this directory; a server started with it stops and says so.
- **The daily limit is per key and per directory.** Two keys sharing one directory each get the full
  daily budget; one key with two different `STELLAR_X402_STATE_DIR` paths gets it twice.
- **The day is a calendar day, not the last 24 hours.** A full daily budget spent just before
  midnight UTC and another just after it means up to twice the daily budget within minutes.
- **Processes paying at the very same moment can pass the daily budget.** Two server processes
  that check the budget at the same instant may both fit; each such process adds at most one
  payment over the budget, never more than `STELLAR_X402_MAX_PER_CALL`. Calls within one process
  never do.
- **To reset the daily budget, delete today's file** in the state directory. It then forgets
  everything spent today, for every key that uses that directory.
- **A refund that cannot be written stays counted.** When a payment fails before it is signed, its
  amount goes back to the daily budget; if today's file cannot be written at that moment, the amount
  stays counted for the day (the log says so). Too strict, never too loose.
- **Every payment sent counts against the budget**, even one the seller refuses afterwards; a
  payment that could not be signed (for example, too little USDC) does not.
- **Sellers are reached only at public addresses over https.** A host whose DNS name points into a
  private network — even with a public certificate — is refused (`unsafe_url`), and so is a name
  with both a public and a private address. `STELLAR_X402_ALLOW_INSECURE_LOCAL=1` opens only this
  machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), over http too; every other host still
  needs https and a public address.
- **`get_resource` sends a real request** without paying. On a path the seller charges for, it gets
  the 402 terms; on a path the seller does not charge for, the seller runs the request.
- The server writes logs to stderr; stdout carries the MCP protocol. The secret key never appears
  in tool output or logs; the log names only the buyer's public address.
