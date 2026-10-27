# stellar-x402

An x402 facilitator for Stellar with Bazaar discovery, an MCP interface and the `upto` scheme.
Built on the Apache-2.0 [`@x402/stellar`](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/stellar)
package. Status: skeleton, nothing implemented yet.

## Layout

| Path                    | Contents                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `apps/facilitator`      | HTTP service: `/verify`, `/settle`, `/supported`, `/discovery/*`, `/mcp` |
| `apps/mcp-local`        | stdio MCP server for paid calls with locally held keys                   |
| `packages/bazaar`       | catalog validation, storage, ranking and search                          |
| `packages/signer-pool`  | channel accounts: funding, sequence tracking, retry, fee bump            |
| `packages/mcp`          | MCP tools (search, paid call) and error codes                            |
| `packages/seller-fetch` | requests to seller URLs: public addresses only, no redirects, limits     |
| `packages/sdk`          | seller, buyer and agent helpers (`/seller`, `/buyer`, `/agent`)          |
| `packages/config`       | shared network config and types                                          |
| `contracts/upto-proxy`  | Soroban contract for the `upto` scheme                                   |
| `examples/`             | two end-to-end integrations                                              |
| `conformance/`          | wire-level conformance runs and report                                   |
| `deploy/`               | per-network config and operational scripts                               |
| `docs/`                 | ADRs, runbook, monitoring, threat model, security reviews                |

## Requirements

- Node.js 22.13+ and pnpm 11 (`corepack enable`)
- Rust stable with the `wasm32v1-none` target, and stellar-cli 25.2+ for contract builds
- Docker, for the PostgreSQL the facilitator's tests run on (`compose.yaml`)

## Commands

```sh
pnpm install
pnpm build
pnpm typecheck
docker compose up -d  # PostgreSQL on 127.0.0.1:15432, or set TEST_DATABASE_URL
pnpm test
pnpm lint
pnpm contracts:test
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
