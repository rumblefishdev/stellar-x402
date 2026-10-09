# Deploy

Testnet and mainnet run as separate deployments. They never share keys.

- `testnet.env.example` and `mainnet.env.example`: environment variables for each deployment.
  Copy to a `.env` file (git-ignored) and fill in.
- `scripts/`: operational scripts (signer funding, testnet reset recovery, contract deploy).
  - `deploy-contract.sh <upto-proxy|test-token>`: builds and deploys a contract to testnet. The
    salt is the WASM hash, so a rerun deploys nothing, changed code gets a new ID, and after a
    testnet reset the same code returns under the same ID. Every run then extends the contract
    instance and its WASM to the network's maximum TTL (about 180 days), so an unused deployment
    isn't archived; `EXTEND_TTL=0` skips that. Prints `<NAME>_WASM_HASH` and
    `<NAME>_CONTRACT_ID`.
  - **The contract ID is per deployer.** It follows from the deployer's address and the WASM
    hash, and the deployer is a local stellar-cli identity (`DEPLOYER`, default
    `x402-testnet-deployer`). Another key, or a build that differs by a byte, gives another ID.
    `UPTO_PROXY_CONTRACT_ID` in `testnet.env.example` is the deployment from task 0035; whether
    the team shares one deployer key is decided with the public testnet deployment (0026).

Hosting and the container setup are chosen in the mainnet milestone.
