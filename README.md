# stellar-x402

An x402 facilitator for Stellar with Bazaar discovery, an MCP interface and the `upto` scheme.
Built on the Apache-2.0 [`@x402/stellar`](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/stellar)
package. Status: skeleton, nothing implemented yet.

## Layout

| Path                    | Contents                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `apps/facilitator`      | HTTP service: `/verify`, `/settle`, `/supported`, `/health`, `/discovery/*` |
| `apps/mcp-local`        | stdio MCP server: its tools (search, paid call), error codes and CLI        |
| `apps/portal`           | the backend the API hub calls: a seller's pubnet API key                    |
| `apps/portal-web`       | the page at `sorobanscan.com/api/x402-facilitator/` (in progress)           |
| `packages/api-keys`     | the API key registry: a key's form and hash, owners, PostgreSQL store       |
| `packages/bazaar`       | catalog validation, storage, ranking and search                             |
| `packages/signer-pool`  | channel accounts: funding, sequence tracking, retry, fee bump               |
| `packages/seller-fetch` | requests to seller URLs: public addresses only, no redirects, limits        |
| `packages/config`       | shared network config and types                                             |
| `packages/sdk`          | TypeScript helpers `@stellar-x402/sdk`: a buyer pays a 402 within limits    |
| `packages/sdk/rust`     | Rust crate `stellar-x402`: a seller charges for a route (axum layer)        |
| `contracts/upto-proxy`  | Soroban contract for the `upto` scheme                                      |
| `examples/`             | a test seller (`http-api`) and a placeholder for a second example           |
| `conformance/`          | wire-level conformance runs and report                                      |
| `deploy/`               | per-network config and operational scripts                                  |
| `docs/`                 | ADRs, runbook, monitoring, threat model, security reviews                   |

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
