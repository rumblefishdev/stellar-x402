# Deploy

Testnet and mainnet run as separate deployments. They never share keys.

- `testnet.env.example` and `mainnet.env.example`: environment variables for each deployment.
  Copy to a `.env` file (git-ignored) and fill in.
- `scripts/`: operational scripts (signer funding, testnet reset recovery, contract deploy).
  - `deploy-contract.sh <upto-proxy|test-token>`: builds and deploys a contract to testnet. The
    salt is the WASM hash, so a rerun deploys nothing, changed code gets a new ID, and after a
    testnet reset the same code returns under the same ID. Prints `<NAME>_WASM_HASH` and
    `<NAME>_CONTRACT_ID`.
  - **The contract ID is per deployer.** It follows from the deployer's address and the WASM
    hash, and the deployer is a local stellar-cli identity (`DEPLOYER`, default
    `x402-testnet-deployer`). Another key, or a build that differs by a byte, gives another ID.
    `UPTO_PROXY_CONTRACT_ID` in `testnet.env.example` is the deployment from task 0004; whether
    the team shares one deployer key is decided with the public testnet deployment (0026).

Hosting: ECS on Fargate in the company AWS account, one service per network, with
stop-before-start deploys ([ADR 0011](../docs/adr/0011-facilitator-hosting.md)). Task 0026 builds
the Dockerfile, the CDK stack under `infra/` and the deploy workflow.
