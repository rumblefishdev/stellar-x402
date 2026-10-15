# stellar-x402-mcp

A local MCP server (stdio) that lets an agent browse the Stellar Bazaar and pay for x402 HTTP
resources on **Stellar testnet**, within limits you set.

| Tool             | What it does                                                                                            | Needs a key |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| `list_resources` | lists catalog entries: price, asset, network, description, how to call                                  | no          |
| `get_resource`   | asks the seller without paying and returns its terms (price, time limit, input and output)              | no          |
| `call_paid_http` | calls the resource, pays the 402 price within the limits, returns the response and the transaction hash | yes         |

Without `STELLAR_X402_SECRET_KEY`, `call_paid_http` is not offered: the client's tool list does not
have it. `list_resources` makes one catalog request per call and never loops over pages: the agent
pages with `limit` and `offset`. Seller-written text is returned as data and cut to the catalog's
limits: descriptions to 500 characters, MIME types to 127. Every failure comes back as a code from
a fixed list ([Error codes](#error-codes)); causes go to stderr only.

To try it locally, run the example seller in [`examples/http-api`](../../examples/http-api)
(`http://localhost:4021/weather?city=Warsaw`, 0.001 testnet USDC) and start this server with
`STELLAR_X402_ALLOW_INSECURE_LOCAL=1`. It is not in any catalog, so give its URL to `get_resource`
or `call_paid_http` directly.

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

Without `STELLAR_X402_SECRET_KEY` the server only lists and previews, and its log says so at the
start; the payment settings are then not used.

## Settings

| Variable                            | Default                | Meaning                                                                                                                     |
| ----------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_X402_DISCOVERY_URL`        | required               | base URL of a server with `GET /discovery/resources`                                                                        |
| `STELLAR_X402_SECRET_KEY`           | none                   | the buyer's Stellar secret key; enables `call_paid_http`                                                                    |
| `STELLAR_X402_MAX_PER_CALL`         | required with a key    | the largest price one call may pay, in atomic units (`10000` = 0.001 USDC)                                                  |
| `STELLAR_X402_DAILY_BUDGET`         | required with a key    | the most one key may spend in one UTC day, all its processes together, in atomic units                                      |
| `STELLAR_X402_STATE_DIR`            | `~/.stellar-x402-mcp/` | where the daily budget keeps what was spent, the SQLite database `spent.sqlite`; an absolute path or one starting with `~/` |
| `STELLAR_X402_TIMEOUT_MS`           | `30000`                | a tool call gives up after this long, all its requests together                                                             |
| `STELLAR_X402_MAX_RESPONSE_BYTES`   | `100000`               | a seller response larger than this is refused (`response_too_large`)                                                        |
| `STELLAR_X402_ALLOW_INSECURE_LOCAL` | `0`                    | `1` also allows `http` to this machine only (below) — **only** for a seller you run on it in tests                          |

Every value is read when the server starts. An empty value means the same as an unset one (the
default applies, a required one is missing). Numbers are plain decimal digits: no `1e3`, hex, sign or
spaces; the time limit and the response limit must be above 0, the two amounts may be 0. A missing
or wrong value, or an unknown `STELLAR_X402_` variable (a misspelt name), stops the server before
it answers the client: exit code 1 and a message on stderr naming the variable. The state
directory's path is checked then too, the directory itself is made at the first payment. A
malformed key is refused without repeating it.

## What to know

- **Use a testnet-only key** that holds only what you are willing to spend. The asset paid is
  testnet USDC; get some at <https://faucet.circle.com> (Stellar Testnet) after adding a USDC
  trustline.
- **Any program running under your user can read the key**, other MCP servers in the same client
  config included: it sits in plain text there. Keep only a small amount on it; a keychain or an
  external signer is planned before mainnet.
- **Two limits, as on a payment card:** `STELLAR_X402_MAX_PER_CALL` for one payment and
  `STELLAR_X402_DAILY_BUDGET` for one day.
- **The daily budget survives restarts and is shared.** Every process paying from the same key and
  using the same `STELLAR_X402_STATE_DIR` counts against one amount per day; the day is the UTC
  date, so it starts again at midnight UTC. What was spent is kept in a SQLite database,
  `spent.sqlite`, in that directory: a table `spent` with one row per counted amount (day, payer,
  asset, amount in atomic units), a refund being a negative row. Each payment is counted in a
  transaction, so the count is exact across processes: processes paying at the very same moment
  never pass the daily budget together.
  If the database cannot be read or written, the server refuses to pay (`payment_failed`) rather than
  guess. The same happens when another server holds the database for more than 5 seconds (a wait
  that is part of the call's time limit); a counted payment takes milliseconds, so a retry
  normally passes.
- **Keep the state directory on a local disk** — not a network drive or a synced folder (iCloud,
  Dropbox). SQLite's own guidance is not to use it over a network filesystem, whose locks it cannot
  rely on.
- **Signing needs the network:** the payment is simulated on the public Stellar testnet RPC before
  it is signed, so the server must reach it; an unfunded payer is found there
  (`insufficient_funds`).
- **Node may print `ExperimentalWarning: SQLite is an experimental feature`** on stderr at start.
  It comes from Node's built-in `node:sqlite`, which keeps the database; it is harmless.
- **The daily limit is per key and per directory.** Two keys sharing one directory each get the full
  daily budget; one key with two different `STELLAR_X402_STATE_DIR` paths gets it twice.
- **The day is a calendar day, not the last 24 hours.** A full daily budget spent just before
  midnight UTC and another just after it means up to twice the daily budget within minutes.
- **To reset the daily budget, delete `spent.sqlite`**, at a moment no payment is being made. It
  then forgets everything spent, today and before, for every key that uses that
  directory. A running server opens the database for each payment, so after the reset it counts in
  the new file with every other server.
- **A refund that cannot be written stays counted.** When a payment fails before it is signed, its
  amount goes back to the daily budget, on the day the payment was counted on (a payment counted at
  23:59 UTC and refunded after midnight goes back to the day before). If the database cannot be
  written at that moment, the amount stays counted for that day (the log says so). Too strict,
  never too loose.
- **Every payment sent counts against the budget**, even one the seller refuses afterwards; a
  payment that could not be signed (for example, too little USDC) does not.
- **Sellers are reached only at public addresses over https.** A host whose DNS name points into a
  private network — even with a public certificate — is refused (`unsafe_url`), and so is a name
  with both a public and a private address. `STELLAR_X402_ALLOW_INSECURE_LOCAL=1` opens only this
  machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), over http too; every other host still
  needs https and a public address. It is decided by the host written in the URL, not by the
  address a name resolves to: `localhost` and `*.localhost` are opened by name, and any other name
  pointing at `127.0.0.1` is still refused.
- **Redirects are never followed.** A seller answering 3xx gets `unsafe_url` (or `payment_unknown`
  once the payment was sent), so a signed payment never reaches another host.
- **The address guard and the size limit cover sellers only, not the catalog.** The catalog is your
  choice in `STELLAR_X402_DISCOVERY_URL` and is trusted as such: it may be http or a private
  address, and its answer has no size limit. It has the time limit, and any failure of it is
  `upstream_error`.
- **One time limit per tool call.** `STELLAR_X402_TIMEOUT_MS` covers everything one call does:
  for `call_paid_http` the unpaid request, the signing and the paid request, each until its body
  has fully arrived. Keep it under the MCP client's own limit (60 s by default) so the agent always
  gets an answer.
- **The response limit counts bytes after decompression,** while the body arrives: a small gzip
  body that unpacks to more than `STELLAR_X402_MAX_RESPONSE_BYTES` is refused.
- **`get_resource` sends a real request** without paying. On a path the seller charges for, it gets
  the 402 terms; on a path the seller does not charge for, the seller runs the request. It shows the
  terms as the seller gives them, without checking them against your limits, asset or network; only
  `call_paid_http` does that. It is stricter in one check a payment does not make: the
  `PAYMENT-REQUIRED` header must match the x402 v2 shape exactly.
  `paymentRequired` is the decoded header as x402 v2 defines it: `x402Version`, `resource`,
  `accepts` (each offer's `scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds`,
  `extra`) and `extensions`. Terms it refuses (`unsupported_payment`) may still
  be paid.

## Error codes

A failure is a tool result with `isError: true`, one text content holding
`{"error":{"code":"…","message":"…"}}` and no structured content; branch on `code`, never on
`message`. The cause (a library or seller error) goes only to stderr.

Two failures do not carry this shape, as the MCP SDK answers them before this server's code runs:
input that does not match the tool's input schema (a missing `url`, an unknown `method`, a negative
`limit`, an argument the tool does not have, such as a misspelt `offest`) and a call to
`call_paid_http` on a server without a key. Their text is plain, such as `MCP error -32602: Input
validation error: …`; nothing was sent for either.

| Code                  | When                                                                                                                                                                                                                                                                                                                                                                                                       | Money may have moved | Daily budget keeps the amount | Retry                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `invalid_input`       | a `GET` with a `body`, in either seller tool                                                                                                                                                                                                                                                                                                                                                               | no                   | no                            | with the input fixed                                                       |
| `unsafe_url`          | the `url` does not parse; it is not https; its host is an IP address, or a name resolving to an address, that is not public; the seller answers a redirect (3xx) before any payment was sent                                                                                                                                                                                                               | no                   | no                            | not the same URL                                                           |
| `resource_not_found`  | the seller answers 404 to the unpaid request                                                                                                                                                                                                                                                                                                                                                               | no                   | no                            | no                                                                         |
| `response_too_large`  | a seller's body is over `STELLAR_X402_MAX_RESPONSE_BYTES` before any payment was sent                                                                                                                                                                                                                                                                                                                      | no                   | no                            | no                                                                         |
| `upstream_error`      | `list_resources`: the catalog cannot be reached, answers an error, returns a page in another shape, or not within the time limit. The seller tools, before any payment was sent: the seller cannot be reached or the time limit passes; `get_resource` gets a status other than 2xx, 402 or 404; `call_paid_http` gets an answer other than 2xx, 402 or 404; signing does not finish within the time limit | no                   | no (given back)               | yes                                                                        |
| `unsupported_payment` | `get_resource`: a 402 without a `PAYMENT-REQUIRED` header in the x402 v2 shape. `call_paid_http`: no offer this server can pay — a network other than `stellar:testnet`, another scheme or x402 version, terms it cannot read, a price that is not a whole number above zero — or every allowed offer wants the payment valid for more than 300 s                                                          | no                   | no                            | no                                                                         |
| `asset_not_allowed`   | no testnet offer is in an allowed asset (the CLI allows testnet USDC only)                                                                                                                                                                                                                                                                                                                                 | no                   | no                            | no                                                                         |
| `over_price_limit`    | every allowed offer costs more than `STELLAR_X402_MAX_PER_CALL`                                                                                                                                                                                                                                                                                                                                            | no                   | no                            | no                                                                         |
| `over_budget`         | the offer chosen would pass what is left of today's budget, also when another process spent it a moment earlier                                                                                                                                                                                                                                                                                            | no                   | no                            | after midnight UTC                                                         |
| `insufficient_funds`  | signing fails because the payer has no USDC trustline or too little USDC                                                                                                                                                                                                                                                                                                                                   | no                   | no (given back)               | after funding the payer                                                    |
| `payment_failed`      | the daily budget database cannot be read or written, or another server held it for over 5 s; or signing fails for another reason                                                                                                                                                                                                                                                                           | no                   | no (given back)               | after fixing the cause in the log; at once if it says `database is locked` |
| `payment_rejected`    | after the payment was sent: the seller's settlement says it failed, or the seller answers 402 again without a settlement. An expired authorization ends here too: the facilitator reports it as a failed check                                                                                                                                                                                             | yes                  | yes                           | only after checking (below)                                                |
| `payment_unknown`     | after the payment was sent, anything else goes wrong: the connection fails, the time limit passes, the body stops arriving or is too large, a redirect, or an answer other than 2xx without a settlement                                                                                                                                                                                                   | yes                  | yes                           | only after checking (below)                                                |

`call_paid_http` checks the seller's offers in this order, and the first check that leaves no offer
gives the code: asset (`asset_not_allowed`), a price above zero and an authorization of at most
300 s (`unsupported_payment`), per-call limit (`over_price_limit`). The offer left is then counted
against the daily budget (`over_budget`). Nothing is signed for any of them.

**`payment_rejected`** means the signed payment reached the seller and the seller, or its
facilitator, said no. Usually nothing was settled, but the signed authorization stays valid until
the seller's time limit (300 s at most) and could still be settled, so it counts as spent.
**`payment_unknown`** means the signed payment left this server and then something failed before a
settlement could be read: the seller may have settled it or not. In both cases no transaction hash
is returned (the log has the cause, not a hash). Do not pay again for the same thing without
checking: look at the payer's account on Horizon or stellar.expert for a USDC payment to the
seller's `payTo` address, after the authorization time has passed.

The settlement is the x402 v2 `PAYMENT-RESPONSE` header (base64 JSON with `success` and
`transaction`). A successful call can still carry `payment.transaction: null`: the seller answered
2xx without a settlement this server can read, or with one whose `transaction` is not 64 hex
characters, the form of a Stellar transaction hash. The
response is what was paid for; the amount counts as spent and the log notes it. An answer other
than 2xx that does carry a successful settlement is returned as a normal result with its `status`
and transaction.

- The server writes logs to stderr; stdout carries the MCP protocol. The secret key never appears
  in tool output or logs; the log names only the buyer's public address.
