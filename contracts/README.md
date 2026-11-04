# Contracts

Soroban contracts, in a Cargo workspace.

- `upto-proxy`: the proxy contract for the x402 `upto` scheme.
- `test-token`: a minimal non-SAC SEP-41 token for the unit tests and the testnet e2e suite.
  Anyone can mint it, so it is never deployed outside testnet.
- `hostile-token`: a SEP-41 token whose `transfer` misbehaves on demand (`set_mode`: 0 normal,
  1 without the payer's `require_auth`, 2 failing on odd ledgers after it, 3 failing after the
  ledger's first transfer), for the facilitator's testnet spend matrix
  (`apps/facilitator/scripts/spend-matrix.ts`). **Testnet only, never deploy it elsewhere**:
  anyone can mint it and anyone can set its mode.
- `test-wallet`: a minimal custom account (one ed25519 key, `__check_auth`), the C-account payer
  of the same matrix. Testnet only: it checks no auth context.

`stellar contract build` builds all four. Without stellar-cli, the spend matrix's three wasm files
build with
`SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 cargo build --release --target wasm32v1-none -p test-token -p hostile-token -p test-wallet`.

```sh
pnpm contracts:test        # cargo test (unit, real-signature and property tests)
pnpm contracts:lint        # cargo fmt --check and clippy -D warnings
pnpm contracts:build       # stellar contract build (stellar-cli 25.2+; 28.1.0 is used)
pnpm contracts:test:wasm   # build, then the WASM interface check and cost measurement
```
