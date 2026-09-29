# Deploy

Testnet and mainnet run as separate deployments. They never share keys.

- `testnet.env.example` and `mainnet.env.example`: environment variables for each deployment.
  Copy to a `.env` file (git-ignored) and fill in.
- `scripts/`: operational scripts (signer funding, testnet reset recovery, contract deploy).

Hosting and the container setup are chosen in the mainnet milestone.
