# Task 0002 spike

This is throwaway code that proves the UptoProxy auth mechanics. It is **not** the production
contract, which task 0003 builds from `G-upto-proxy-contract-spec`. It is kept here as evidence
for [`R-testnet-spike`](../notes/R-testnet-spike.md).

- `contract/`: a minimal `settle_upto` (the approve-in-tree design) and a `settle_wrong_order`
  control, with 7 unit tests. It is a standalone Cargo project, not part of `contracts/`.
- `client/`: `spike.ts`, which uses `@stellar/stellar-sdk` 17.2.0 and runs directly on Node 24
  (type stripping). It is not part of the pnpm workspace.
- `results/testnet-run.json`: the output of the last run.

## Reproduce

```sh
# Unit tests
cd contract && cargo test

# Testnet
stellar contract build
for n in client facilitator seller issuer channel; do
  stellar keys generate upto-spike-$n --network testnet --fund
done
ISS=$(stellar keys address upto-spike-issuer); A="UPSPIKE:$ISS"
for n in client seller; do stellar tx new change-trust --source upto-spike-$n --line $A --network testnet; done
# --amount is in stroops
stellar tx new payment --source upto-spike-issuer --destination $(stellar keys address upto-spike-client) \
  --asset $A --amount 100000000000 --network testnet
TOKEN_ID=$(stellar contract asset deploy --asset $A --source upto-spike-issuer --network testnet)
PROXY_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/upto_spike.wasm \
  --source upto-spike-facilitator --network testnet)

cd ../client && pnpm install --ignore-workspace
CLIENT_SECRET=$(stellar keys show upto-spike-client) \
FACILITATOR_SECRET=$(stellar keys show upto-spike-facilitator) \
SELLER_SECRET=$(stellar keys show upto-spike-seller) \
CHANNEL_SECRET=$(stellar keys show upto-spike-channel) \
TOKEN_ID=$TOKEN_ID PROXY_ID=$PROXY_ID node spike.ts
```
