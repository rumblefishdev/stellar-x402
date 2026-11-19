---
title: "Spike: forged payer through a token that skips require_auth, and the nonce-footprint check"
type: research
status: mature
tags: [facilitator, security, soroban, spike]
---

# Spike: forged payer and the nonce-footprint check (testnet, 2026-10-30)

Throwaway; nothing in the repo changed. Script [`spike-payer-proof.mjs`](spike-payer-proof.mjs) (run from a directory holding
`contracts/` with the built wasm and `node_modules` linked to `apps/facilitator`'s), raw output
[`spike-payer-proof-results.json`](spike-payer-proof-results.json), contracts
built from a copy of `contracts/test-token` (soroban-sdk 28.0.0, Rust 1.97.1, `cargo` with
`SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1`, no stellar-cli). `noauth-token` is
`test-token` with `from.require_auth()` removed from `transfer`. Facilitator = upstream
`@x402/stellar` 2.28.0 `ExactStellarScheme` (facilitator side, `maxTransactionFeeStroops`
250,000); honest payloads from upstream's client `ExactStellarScheme`.

Contracts: noauth-token `CB42Q4JSGVCP5SEANNMENS4JZLXVI37ZDQKUH5NDINKTXAU6B6P65NHE`, test-token
`CBDENRYRSOFEC3UAS3OSJ3NTMGSTLMX6YA5O6Q6BM6TFPIGXFDRQWWMA`, XLM SAC
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`. Facilitator
`GCLK526EQOIJSEFV537LG7DLXOWLYUCLR2ENUWEINP62XZ3LMCIQ7NVR`, victim (never signed)
`GD5N6IO4255DMFCK73CHIQKFJH64P4NLEGLTLSJJA4KVE4RXS5SAO47E`.

| Case | Upstream `verify` | Enforce simulation | Payer nonce in read-write footprint |
|---|---|---|---|
| A forged payer (victim, random 64-byte signature), token without `require_auth` | **`isValid: true`, payer = victim** | success | **no** |
| B honest payer, test-token | `isValid: true` | success | yes |
| C honest payer, native XLM SAC | `isValid: true` | success | yes |
| D forged payer, native XLM SAC | `invalid_exact_stellar_payload_simulation_failed` | `Error(Auth, InvalidAction)`, "failed ED25519 verification" | no |

Settle through upstream's own `settle`:
- **A: `success: true`**, tx `ee726e6b74f37dc3eedce57c5e054a9b89b6621070f429d76204b32eefd3df87`
  (ledger 5,467,790), source = the facilitator, fee 21,982 stroops paid by the facilitator. The
  victim's balance went 1000 → 990 without the victim signing anything.
- B: `success: true`, tx `2d59dfc6a54e2b2e5667ed1846556a1de36fb9244f2fc7f8545b3c83c97bdcae`,
  fee 25,837.

## Conclusions

1. **The hole holds on a real host** (research D, until now source-level only). A token that
   skips `require_auth` passes upstream verify and settles with an attacker-chosen payer, any
   nonce and a garbage signature; the facilitator pays the fee and records the victim as payer.
   A SAC is not affected (D).
2. **The M1 check separates the cases exactly**: the payer's nonce key is in the enforce
   simulation's read-write footprint for both honest payments (wasm and SAC) and absent for the
   forged one. The check needs no extra RPC call: the pool already runs this simulation.

## Not covered

- C-account payers (`__check_auth`) and credentials v2: expected to write the nonce the same way
  (CAP-46-11, CAP-71-02), to test in the implementation's testnet e2e.
- Our facilitator end to end (our `verify.ts` checks on top of upstream, the pool's rebuild on a
  channel): case A satisfies those checks by construction (one entry for the payer, expiration in
  window), so it is expected to pass them today; the implementation's e2e pins it.
