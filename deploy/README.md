# Deploy

Testnet and mainnet run as separate deployments. They never share keys.

- `testnet.env.example` and `mainnet.env.example`: environment variables for each deployment.
  Copy to a `.env` file (git-ignored) and fill in.
- `scripts/`: operational scripts (signer funding, testnet reset recovery, contract deploy).
  - `deploy-contract.sh <upto-proxy|test-token>`: builds and deploys a contract to testnet. The
    salt is the WASM hash, so a rerun deploys nothing, changed code gets a new ID, and after a
    testnet reset the same code returns under the same ID. Prints `<NAME>_WASM_HASH` and
    `<NAME>_CONTRACT_ID`.

Hosting and the container setup are chosen in the mainnet milestone.
