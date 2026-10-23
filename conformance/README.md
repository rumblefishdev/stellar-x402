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
   signers, in a ledger after the last one RPC had closed before the suite started (ledgers, not
   the local clock). A hash RPC cannot answer for is a failure too. Saves the run either way,
   unless interrupted (Ctrl+C, `kill`, a closed terminal); the temporary folder is deleted then
   too.

The gate runs as one Node process (`node --import tsx`), not under the `tsx` command: that
wrapper kills its child outright when the child does not answer a signal within ~30 ms, and the
gate cannot while it waits for a build step or the suite, so its temporary folder stayed behind.
A signal sent to the whole process group (Ctrl+C, a closed terminal) stops the running step at
once. One sent to the gate's process alone takes effect at the gate's next wait on the network:
after the whole build, or after the whole suite, its payments made and the run not saved. `pnpm`
returns before the gate has finished deleting the folder.

The proxy (`external-proxy/proxy.mjs`) answers the suite's `/health` and `/close` itself and
forwards `/verify`, `/settle` and `/supported` to `GATE_FACILITATOR_URL` unchanged. It uses Node
built-ins only, because nothing is installed for it inside the suite.

## What it spends

One payment of 0.001 testnet USDC per scenario, from the buyer to the seller; the facilitator pays
the fees.

## Results

One folder per run, `results/<date>-<facilitator host>/`, with two files:

- `suite.json`: the suite's own `--output-json` file, copied byte for byte. It is what the
  unmodified x402 tests say: one row per scenario with its transaction hash.
- `gate.json`: what the gate says about it: `suite.json`'s name and SHA-256, the upstream repo and
  commit, the date, the facilitator URL and its signers, the command, when the run started and the
  last ledger closed before it, the suite's exit code, whether the gate passed and why not, and each transaction as the chain shows
  it (ledger, time, fee payer, call). Only runs against our facilitator are committed (task 0029);
  dry runs against a public facilitator stay out of git.

The suite's Bazaar check (`--extensions=bazaar`) is not run: it also calls `/discovery/search`,
which comes after Tranche 1.
