# stellar-x402-mcp testnet e2e

End-to-end run of `stellar-x402-mcp` (task 0037): the built CLI started over MCP stdio, the way an
MCP client such as Claude Desktop starts it. Unit tests in `packages/mcp` cover the logic in one
process with fakes; this run covers what they cannot: the built binary and its settings, real
stdio, real signing, two real payments on testnet, and the buyer's secret absent from everything
the servers write.

The scenarios (E-01…E-23) were written from the README, the tool list and the acceptance criteria
only, by a reviewer who had not read the code.

## Run

```sh
pnpm e2e:testnet      # from the repo root: builds the CLI and the example seller, then runs
```

It needs `.env.e2e-testnet` at the repo root (git-ignored), or the file named by `E2E_ENV_FILE`:

| Variable            | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `E2E_BUYER_PUBLIC`  | testnet account with a USDC trustline and at least 0.01 USDC     |
| `E2E_BUYER_SECRET`  | its secret key; only ever passed to the server in its env        |
| `E2E_SELLER_PUBLIC` | testnet account with a USDC trustline that receives the payments |

The run checks balances on Horizon, so these accounts must not be used by another run at the same
time. Testnet USDC comes from Circle's faucet; friendbot gives only XLM. The run also creates one fresh
account with friendbot, without a USDC trustline, for the `insufficient_funds` case.

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
