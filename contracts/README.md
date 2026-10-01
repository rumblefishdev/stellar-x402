# Contracts

Soroban contracts, in a Cargo workspace.

- `upto-proxy`: the proxy contract for the x402 `upto` scheme.

```sh
pnpm contracts:test        # cargo test (unit, real-signature and property tests)
pnpm contracts:lint        # cargo fmt --check and clippy -D warnings
pnpm contracts:build       # stellar contract build (stellar-cli 25.2+; 28.1.0 is used)
pnpm contracts:test:wasm   # build, then the WASM interface check and cost measurement
```
