# Task 0006 bench

This is throwaway load-test code for the `upto` scaling research. It is evidence for
[`R-testnet-throughput-measurements`](../notes/R-testnet-throughput-measurements.md),
[`R-verify-cost`](../notes/R-verify-cost.md) and
[`R-network-limits-and-mainnet-usage`](../notes/R-network-limits-and-mainnet-usage.md).

- `bench.ts` settles real `upto` payments through the deployed UptoProxy (`setup`, `delegate`,
  `shapes`, `burst`, `run`, `verify`, `placement`). See the comment at the top of the file.
- `mainnet-usage.ts` samples recent mainnet ledgers for Soroban usage. It only reads.
- `results/` holds the output of the runs recorded in the notes. It contains public keys and
  transaction hashes only.
- `secrets/` (git-ignored) holds the generated client, seller and channel keys.

It uses `@stellar/stellar-sdk` 17.2.0 and runs directly on Node 24, using type stripping. It is
not part of the pnpm workspace.

## Reproduce

It reuses the 0002 spike accounts and the 0003 deployment
([R-manual-testnet-verification](../../../archive/0003_FEATURE_upto-proxy-contract/notes/R-manual-testnet-verification.md)).

```sh
pnpm install --ignore-workspace
export FACILITATOR_SECRET=$(stellar keys show upto-spike-facilitator) \
  ISSUER_SECRET=$(stellar keys show upto-spike-issuer) \
  TOKEN_ID=CCH46PUSMDVRYST4IC5QZ32OCSFGQV2SDM5MOJW3ETBYG5326OKHNQ2P \
  PROXY_ID=CBEPV3F2FBNUXFSXFS6Q5R6D45KZADCUGCB62KBNWGFCCCMWL26TEGY7

node bench.ts setup 230 20 120      # clients, sellers, channels
node bench.ts delegate 50           # facilitator as signer on channels 0-49
node bench.ts shapes
node bench.ts burst 20
node bench.ts run 50 200 opsource-bump many    # <channels> <count> <shape> <one|many sellers>
node bench.ts run 120 480 opsource-bump one
node bench.ts placement results/run-opsource-bump-c120-n480-one.json
node bench.ts verify 1000 100       # <requests> <concurrency>
node mainnet-usage.ts 720           # ledgers to sample
```
