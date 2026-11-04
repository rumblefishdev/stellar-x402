# stellar-x402-mcp testnet e2e

End-to-end run of `stellar-x402-mcp` (task 0037): the built CLI started over MCP stdio, the way an
MCP client such as Claude Desktop starts it. Unit tests in `packages/mcp` cover the logic in one
process with fakes; this run covers what they cannot: the built binary and its settings, real
stdio, real signing, two real payments on testnet, and the buyer's secret absent from everything
the servers write.

The scenarios (E-01…E-23) were written from the README, the tool list and the acceptance criteria
only, by a reviewer who had not read the code; E-09h, E-14b, E-14c and E-24 came from a second,
independent review of what the first set left out.

## Run

```sh
pnpm mcp:e2e   # from the repo root: builds the CLI and the example seller, then runs
```

It needs `.env.e2e-testnet` at the repo root (git-ignored), or the file named by `E2E_ENV_FILE`:

| Variable            | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `E2E_BUYER_PUBLIC`  | testnet account with a USDC trustline and at least 0.01 USDC     |
| `E2E_BUYER_SECRET`  | its secret key; only ever passed to the server in its env        |
| `E2E_SELLER_PUBLIC` | testnet account with a USDC trustline that receives the payments |

The run checks balances on Horizon, so these accounts must not be used by another run at the same
time. Testnet USDC comes from Circle's faucet; friendbot gives only XLM. The run also creates two
fresh accounts with friendbot for `insufficient_funds`: one without a USDC trustline, one with a
trustline and no USDC.

## Scenarios

| Group                   | Scenarios          | What they prove                                                                                                                 |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| start-up                | E-01 – E-03        | wrong settings stop the server (exit 1, the variable named); 2 tools without a key, 3 with                                      |
| catalog                 | E-04 – E-06        | filters and paging passed on, one request per call; catalog failures; input failing a schema                                    |
| `get_resource`          | E-07 – E-09        | the real seller's terms; every seller failure's code; the address guard, and a public https name passing it                     |
| refusals before signing | E-10 – E-13a       | each refusal in the documented order, with nothing signed                                                                       |
| after signing           | E-13b – E-20, E-24 | what was signed (from the transaction), empty wallets, every after-payment code, one deadline per call, the shared daily budget |
| real payments           | E-21, E-22         | two payments settled on testnet, checked on Horizon; then over the budget and over the price limit                              |
| secrets                 | E-23               | no secret in anything the servers wrote                                                                                         |

## What it spends

Two payments of 0.001 testnet USDC (E-21, E-22) to the example seller (`examples/http-api`,
started locally), settled by the public x402.org facilitator. Every other paid path uses a local
fake seller (`src/fakes.ts`) whose 402 copies the example seller's, so a real key signs it; the
fake never forwards the signed payment, so no money moves. It is not the fake of the unit tests
(`packages/mcp/test/fake-seller.ts`), which settles in process with fake signing; the catalog fake
is shared.

## Results

`results/testnet-results.json`: the commit it ran on, then one row per check, with what was
expected, what came back, and the transaction hash of a real payment. A failed row fails the run,
but the scenarios after it still run, so the table is complete. A run whose setup fails (no key
file, too little USDC, friendbot or the seller down) writes the error instead of rows.
