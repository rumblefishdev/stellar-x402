# Conformance

The Tranche 1 gate ([ADR 0009](../docs/adr/0009-conformance-gate-harness.md)): the unmodified
x402 end-to-end suite from `x402-foundation/x402`, at a pinned commit, runs every Stellar `exact`
scenario against a facilitator, and the run is saved with the transaction hashes.

## Run

```sh
GATE_FACILITATOR_URL=https://x402.org/facilitator pnpm conformance:e2e
```

`GATE_FACILITATOR_URL` is the facilitator under test, without a trailing slash. The public x402.org
facilitator settles Stellar testnet, so it proves the harness before ours is deployed.

The run needs the testnet accounts of the MCP e2e run: `.env.e2e-testnet` at the repo root
(git-ignored), or the file named by `E2E_ENV_FILE`, with `E2E_BUYER_SECRET` (an account holding
testnet USDC, which pays) and `E2E_SELLER_PUBLIC` (an account with a USDC trustline, which is paid).
See [apps/mcp-local/e2e/README.md](../apps/mcp-local/e2e/README.md) for funding them.

The suite kills whatever listens on ports 4022–4060 before it starts.

## What it does

1. Reads the Stellar signers from `GATE_FACILITATOR_URL/supported`, before any payment.
2. Clones the suite at the commit pinned in `src/upstream.ts` into a new temporary folder, which
   is deleted when the gate exits, so no build from an earlier run is reused.
3. Installs and builds upstream's TypeScript SDK, the suite and its TypeScript components, the way
   upstream's CI does (~2.5 minutes, ~6 GB on disk while the run lasts). Upstream's
   `setup.sh` is not run: it also builds the Go and Python components, which the Stellar scenarios
   never start.
4. Copies `external-proxy/` into the suite as `e2e/facilitators/external-proxies/stellar-x402/`,
   the folder upstream keeps for external facilitators, and stops if any tracked file differs from
   the pinned commit.
5. Runs every Stellar `exact` scenario: each canonical TypeScript client and server, HTTP and MCP,
   both routes (`/exact/stellar`, and `/exact/stellar/upfront`, which settles before serving).
6. Fails unless the suite exited 0, every scenario passed with a hash and no two report the same
   hash. Reads every hash from Stellar RPC and fails unless each succeeded as one `transfer` of
   0.001 testnet USDC from the buyer to the seller, its fee paid by one of the facilitator's
   signers, after the run started. A hash RPC cannot answer for is a failure too. Saves the run
   either way, unless interrupted (Ctrl+C).

The proxy (`external-proxy/proxy.mjs`) answers the suite's `/health` and `/close` itself and
forwards `/verify`, `/settle` and `/supported` to `GATE_FACILITATOR_URL` unchanged. It uses Node
built-ins only, because nothing is installed for it inside the suite.

## What it spends

One payment of 0.001 testnet USDC per scenario, from the buyer to the seller; the facilitator pays
the fees.

## Results

`results/<date>-<facilitator host>.json`: the upstream repo and commit, the date, the facilitator
URL and its signers, the command, when the run started, whether the gate passed and why not, each
transaction as the chain shows it (ledger, time, fee payer, call), then the suite's own summary and
one row per scenario. Only runs against our facilitator are committed (task 0029); dry runs against
a public facilitator stay out of git.

The suite's Bazaar check (`--extensions=bazaar`) is not run: it also calls `/discovery/search`,
which comes after Tranche 1.
