---
id: "0003"
title: "Implement the UptoProxy Soroban contract with unit tests"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0002", "0004", "0005"]
tags: [layer-contracts, upto, priority-high, effort-medium]
links:
  - ../../../contracts/upto-proxy
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. Starts after 0002's spec is approved."
---

# Implement the UptoProxy Soroban contract with unit tests

## Summary

Implement `contracts/upto-proxy` exactly as 0002's `G-upto-proxy-contract-spec` describes. Add
unit tests that prove each of the five `upto` properties, both with real signatures and with the
auth tree. Produce a reproducible WASM build.

## Status: Backlog

> Blocked by 0002 (spec approval).

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

- [ ] The contract matches the G- spec: every deviation goes back to 0002 first
- [ ] Every test listed above passes, including real-signature tests
- [ ] fmt, clippy and test are clean; the WASM builds with stellar-cli 25.2+
- [ ] The resource cost per settlement is recorded
