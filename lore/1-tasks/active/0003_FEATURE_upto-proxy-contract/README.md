---
id: "0003"
title: "Implement the UptoProxy Soroban contract with unit tests"
type: FEATURE
status: active
milestone: 1
related_adr: []
related_tasks: ["0002", "0004", "0005", "0006"]
tags: [layer-contracts, upto, priority-high, effort-medium]
links:
  - ../../../../contracts/upto-proxy
  - notes/R-manual-testnet-verification.md
  - notes/S-batching-and-throughput.md
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. Starts after 0002's spec is approved."
  - date: "2026-10-01"
    status: active
    who: okarcz
    note: "Started. 0002's spec was approved when PR #1 merged."
---

# Implement the UptoProxy Soroban contract with unit tests

## Summary

Implement `contracts/upto-proxy` exactly as 0002's `G-upto-proxy-contract-spec` describes. Add
unit tests that prove each of the five `upto` properties, both with real signatures and with the
auth tree. Produce a reproducible WASM build.

## Status: Active

> Contract and tests written (2026-10-01), reviewed in PR #2 (CI green at `f3bd2b5`) and
> verified by hand on testnet on 2026-10-02
> ([R-manual-testnet-verification](notes/R-manual-testnet-verification.md)). Awaiting merge.

## Context

The contract is the trust boundary of the `upto` scheme: a bug here moves client funds. The unit
tests have to show that the signed payload leaves out `actual_amount` and binds everything else.
`mock_all_auths` alone cannot show this.

## Implementation Plan

### Step 1: Toolchain

Upgrade stellar-cli to 25.2+ (25.1 is installed, and soroban-sdk 28 needs 25.2+). Check that
`pnpm contracts:build` produces the WASM.

### Step 2: Contract

- `#![no_std]`, soroban-sdk 28, with no dependencies beyond the SDK.
- `settle_upto` as the spec defines it. The order is: validate the inputs, call
  `from.require_auth_for_args`, apply the facilitator binding, check the time window, consume the
  nonce, run the allowance or transfer mechanism, then emit the event.
- Typed `#[contracterror]` codes and a `#[contractevent]` settlement event.
- A read-only `is_nonce_used(from, nonce)` for facilitator verification.

### Step 3: Unit tests (`src/test.rs`, testutils)

- Happy path: `actual < max`, `actual == max`, `actual == 0`.
- Rejections: `actual > max`, a negative or zero `max`, before `valid_after`, after `deadline`,
  a replayed nonce while its entry lives (I4), `from == to`, `to ==` the proxy, a missing
  facilitator auth, and insufficient balance.
- Auth tree: `env.auths()` equals the expected tree, the signed args hold no `actual_amount`, and
  the sub-invocation matches the spec.
- Real ed25519 signatures (not `mock_all_auths`): one signed entry settles different
  `actual_amount` values, and changing `to`, `token`, `max_amount`, `nonce`, the window or
  `facilitator` fails the signature.
- Tokens: the SAC (`register_stellar_asset_contract_v2`) and a minimal non-SAC SEP-41 test token
  written in-repo. No third-party token code.
- Property test over amount bounds (`proptest`, dev-dependency only).
- Resource cost of one settlement, measured with the budget or cost estimate and recorded for 0005.

### Step 4: Quality gates

`cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` and the WASM build all pass. Check
the WASM size and record it.

## Acceptance Criteria

- [x] The contract matches the G- spec: no deviations
- [x] Every test listed above passes, including real-signature tests (27 + 2 WASM tests)
- [x] fmt, clippy and test are clean; the WASM builds with stellar-cli 28.1.0
- [x] The resource cost per settlement is recorded (below)

## Implementation Notes

- `contracts/upto-proxy/src/lib.rs`: `settle_upto` and `is_nonce_used` exactly as spec §2–§7, with
  the §4 step order, `UptoError` 1–8 and the `UptoSettled` event (`upto_settled` topic, map data).
- `src/test/mod.rs`: fixture plus mocked-auth tests using the exact §3.1/§3.2 trees, run against
  both the SAC and the in-repo token. `real_signatures.rs`: ed25519-signed `ADDRESS` entries for
  classic accounts, verified by the host. `amount_properties.rs`: proptest, 128 cases.
  `sep41_token.rs`: the non-SAC test token. `wasm.rs`: `#[ignore]`d tests on the release WASM.
- Mutation check: 12 hand-made mutations (dropped facilitator auth, unsigned facilitator, no nonce
  write, no TTL extension, exclusive deadline, missing expiry checks, approve before auth, transfer
  of max, no event, no `to == proxy` check, approve of actual) each fail at least one test.
- WASM: 4,145 bytes, hash `be2ba121…0b34`, identical after `cargo clean`. Exports only
  `settle_upto` and `is_nonce_used` (I7, checked from the `contractspecv0` section).
- Cost (WASM + SAC, mocked auth, `pnpm contracts:test:wasm`):

  | actual | instructions | reads | writes | events | fee without rent |
  |---|---|---|---|---|---|
  | 500 | 903,417 | 1 disk + 11 memory | 6 / 1,052 B | 896 B | 31,889 stroops |
  | 0 | 670,907 | 0 disk + 9 memory | 4 / 604 B | 660 B | 20,462 stroops |

  Rent is left out: mocked auth writes its nonces with `max_live_until_ledger`
  (soroban-env-host `auth.rs`), so the estimate's rent is not what a real client entry pays.
  Signature verification is not included either. 0004 measures the real fee on testnet.
- Scripts: `contracts:lint`, `contracts:test:wasm`. CI's `contracts` job now runs fmt, clippy,
  tests, `stellar contract build` (via `stellar/stellar-cli@v28.1.0`) and the WASM tests.
- Manual testnet run (2026-10-02, proxy `CBEPV3F2…TEGY7`, WASM `be2ba121…0b34`): every `upto`
  property held on-chain. A normal settlement costs the facilitator 30,090–40,699 stroops; the
  client's first one through a proxy cost 97,963. Steps, commands and tx hashes are in
  [R-manual-testnet-verification](notes/R-manual-testnet-verification.md).

## Issues Encountered

- **soroban-sdk 28 refuses plain `cargo build` for WASM**: its build script requires stellar-cli
  25.2+. CI installs stellar-cli with the official action instead of building with cargo.
- **Auth-entry objects are per-`Env`**: reusing a `Payment` built in one test `Env` inside another
  fails with `Error(Object, InternalError)`. Signed entries are XDR and portable; Soroban values
  are not. Real-signature tests rebuild values in each `Env` from fixed seeds and contract IDs.
- **Test snapshots**: the SDK writes one JSON per `Env`; proptest alone produced ~200 files
  (3.5 MB). `contracts/**/test_snapshots/` is gitignored.

## Design Decisions

### Emerged (confirmed by okarcz, 2026-10-01)

1. **Real-signature tests use the in-repo token, not the SAC**: a classic account can hold a SAC
   balance only through a trustline entry. The SAC with real signatures was already proven on
   testnet in the 0002 spike (S1–S8) and is covered again by 0004; mocked-tree tests cover the
   SAC here.
2. **WASM-level tests are `#[ignore]`d**: they need the release WASM, which needs stellar-cli. CI
   builds it and runs them with `--ignored`; locally `pnpm contracts:test:wasm`.
3. **Test snapshots are gitignored**: tests assert state explicitly, so snapshots add no
   protection, only ~200 churning files.
4. **Rust toolchain pinned to 1.97.1** in `contracts/rust-toolchain.toml` (with rustfmt and
   clippy), and CI installs the same version. The `contracts:*` scripts `cd contracts` first,
   because rustup only reads the toolchain file from the current directory upward. The WASM
   hash is unchanged (`be2ba121…0b34`). Upgrading Rust is now a deliberate change that records
   a new hash.

## Future Work

- Scaling the settlement flow (session aggregation, channel accounts and fee bumps, optional
  batch router): research task 0006. Background in
  [S-batching-and-throughput](notes/S-batching-and-throughput.md).
