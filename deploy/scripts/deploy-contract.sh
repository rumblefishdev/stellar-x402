#!/usr/bin/env bash
# Builds and deploys one contract from contracts/ to testnet. Idempotent: the salt is the WASM
# hash, so the contract ID follows from the deployer's address and the code. A rerun finds the
# contract and deploys nothing; changed code gets a new ID (the contracts are immutable). After a
# testnet reset, the deployer is funded again and the contract redeployed under the same ID.
#
# The ID is per deployer: another deployer key, or a WASM build that differs by a byte (another
# toolchain or stellar-cli version), gives another ID. UPTO_PROXY_CONTRACT_ID in
# deploy/testnet.env.example is okarcz's deployment.
#
# Every run then extends the contract instance and its WASM to the network's maximum TTL (about
# 180 days on testnet), so a deployment that nobody settles on isn't archived. UptoProxy also
# extends itself on every settlement (task 0035).
#
# Usage: deploy/scripts/deploy-contract.sh <upto-proxy|test-token>
# Env:   DEPLOYER    stellar-cli identity that deploys (default x402-testnet-deployer; created and
#                    funded with friendbot when missing)
#        EXTEND_TTL  0 skips the TTL extension, e.g. to measure the contract's own extension
# Prints: <NAME>_WASM_HASH=… and <NAME>_CONTRACT_ID=… on stdout, e.g. UPTO_PROXY_CONTRACT_ID.
set -euo pipefail

name=${1:?usage: deploy-contract.sh <upto-proxy|test-token>}
deployer=${DEPLOYER:-x402-testnet-deployer}
network=testnet
root=$(git rev-parse --show-toplevel)
manifest="$root/contracts/$name/Cargo.toml"
wasm="$root/contracts/target/wasm32v1-none/release/${name//-/_}.wasm"
var=$(echo "${name//-/_}" | tr '[:lower:]' '[:upper:]')

[[ -f $manifest ]] || {
  echo "no contract at contracts/$name" >&2
  exit 1
}
stellar contract build --manifest-path "$manifest" --quiet >&2

if ! stellar keys address "$deployer" >/dev/null 2>&1; then
  stellar keys generate "$deployer" --network "$network" >&2
fi
# Friendbot only funds accounts that don't exist, so this is a no-op unless testnet was reset.
stellar keys fund "$deployer" --network "$network" >&2 2>/dev/null || true

hash=$(sha256sum "$wasm" | cut -d' ' -f1)
id=$(stellar contract id wasm --salt "$hash" --source "$deployer" --network "$network")
if stellar contract info interface --contract-id "$id" --network "$network" >/dev/null 2>&1; then
  echo "$name: already deployed at $id" >&2
else
  stellar contract deploy --wasm "$wasm" --salt "$hash" --source "$deployer" \
    --network "$network" --quiet >/dev/null
  echo "$name: deployed at $id" >&2
fi

if [[ ${EXTEND_TTL:-1} != 0 ]]; then
  # The highest TTL an entry can have is max_entry_ttl - 1 ledgers.
  max=$(stellar network settings --network "$network" | grep -o '"max_entry_ttl":[0-9]*' | cut -d: -f2)
  [[ -n $max ]] || {
    echo "could not read max_entry_ttl from the network settings" >&2
    exit 1
  }
  for target in "--id $id" "--wasm $wasm"; do
    # shellcheck disable=SC2086 # $target is two words on purpose
    until=$(stellar contract extend $target --ledgers-to-extend $((max - 1)) --ttl-ledger-only \
      --source "$deployer" --network "$network" --quiet)
    echo "$name: ${target%% *} live until ledger $until" >&2
  done
fi
echo "${var}_WASM_HASH=$hash"
echo "${var}_CONTRACT_ID=$id"
