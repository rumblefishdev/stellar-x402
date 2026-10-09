# UptoProxy testnet e2e

End-to-end suite for `contracts/upto-proxy` on Stellar testnet (task 0004). It uses the role split
the x402 facilitator will use:

- **Client:** simulates `settle_upto` with the ceiling as a placeholder amount and signs only its
  auth entry. It never builds, signs or pays for a transaction.
- **Facilitator:** checks the client's auth tree against the payment terms, swaps in the actual
  amount and submits through `SettlementSubmitter` from `packages/signer-pool`. The transaction
  is in the delegated-bump shape: a channel account is the transaction source, the facilitator
  is the operation source and pays the fee bump (ADR 0003).
- **Seller:** the recipient.

## Run

```sh
pnpm contracts:e2e                          # from the repo root: all three tokens
E2E_TOKENS=sac,sep41 pnpm contracts:e2e     # without USDC
```

The first run creates the accounts in `secrets/accounts.json` (git-ignored) and funds them with
friendbot. Every run then:

1. deploys the proxy and the test token with `deploy/scripts/deploy-contract.sh` (a no-op when
   they're already there);
2. opens the trustlines, deploys the SACs and tops up the self-issued asset and the test token;
3. reuses or creates the facilitators' channel accounts;
4. runs the scenarios and writes `results/testnet-results.json`.

After a testnet reset, the same command rebuilds everything, except for USDC.

The contract IDs depend on the deployer key (see `deploy/README.md`). When the proxy the suite
deployed differs from `UPTO_PROXY_CONTRACT_ID` in `deploy/testnet.env.example`, setup prints a
warning: the run is then testing your own deployment, not the recorded one.

[`results/testnet-report.md`](results/testnet-report.md) summarizes the 2026-10-08 run. It is a
snapshot: a new run rewrites the JSON but not the report.

### Testnet USDC

Only Circle's faucet hands out testnet USDC. When the client holds less than 0.5 USDC, setup stops
and prints the client's address. Send USDC to it from <https://faucet.circle.com> (network:
Stellar testnet) and rerun.

## Scenarios

For each token (Circle testnet USDC, a self-issued asset through its SAC, and the in-repo non-SAC
SEP-41 `test-token`):

- **Settles:** below the ceiling, at the ceiling and zero. Each one checks the balance deltas, the
  `upto_settled` event, the used nonce, the leftover allowance and the transaction's fee payer
  and sources.
- **Rejected:** an amount over the ceiling, a replayed auth entry, a reused nonce with a new
  signature, before `valid_after`, after the deadline, and a different facilitator.
- **Tampering:** changing the recipient, token, ceiling or nonce breaks the client's signature, and
  so does another facilitator rewriting the `facilitator` argument to itself.
- **Concurrency:** two authorizations from one payer, one after the other and in the same ledger
  (up to 3 attempts, since two parallel submits can straddle a ledger close). Both get the same
  checks as any settlement.

Rejections are checked in the submitter's enforcing simulation against live testnet state, the
same path the facilitator uses, so they have no transaction hash. A final check confirms the
client's XLM balance did not change during the scenarios: it pays no settlement fees (setup pays
the fees for its trustlines).
