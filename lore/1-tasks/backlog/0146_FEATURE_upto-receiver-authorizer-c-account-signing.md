---
id: "0146"
title: "Let a seller's C... contract account sign the upto receiver authorization"
type: FEATURE
status: backlog
milestone: 3
related_adr: ["0001", "0010"]
related_tasks: ["0034", "0015", "0140", "0102"]
tags: [upto, sdk, seller, smart-wallet, priority-low, effort-medium, payments]
links:
  - ../blocked/0034_FEATURE_upstream-upto-stellar/drafts/scheme_upto_stellar.md
history:
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0034 future work ("C-account signing in our seller SDK"). Milestone 3: Tranche
      #2 only submits the spec (D3), and both places this lands come after it (the upstream
      `upto` server class after 0015, and 0140).
---

# Let a seller's C... contract account sign the upto receiver authorization

## Summary

As a seller whose account is a Soroban contract account (a `C...` smart wallet), I want to use
self-managed `upto` mode, so that I can authorize my own claims without a `G...` key.

## Context

- In self-managed mode the seller is the receiver authorizer: at `/settle` it sends
  `payload.receiverAuthorization`, its own `SorobanAuthorizationEntry` for `settle_upto` covering
  every argument, `actual_amount` included (spec, "Receiver Authorizer Modes" and "Receiver
  Authorization Entry"; 0034, review of #3781).
- The spec already allows `G...` and `C...` receiver authorizers. A `C...` one is checked only by
  the enforcing simulation, through the wallet's `__check_auth`, as for a smart-wallet client
  (okarcz's decision of 2026-11-12, in 0034).
- Our seller-side code signs with a `G...` key first, through a pluggable signer, so `C...`
  signing can come later. This task is that later step.
- A `C...` account has no single signature format: `__check_auth` decides what the signature is
  (ed25519 signers, passkeys/secp256r1, policies). The signer has to hand back whatever the
  wallet expects.

## Where it lands

Both places the seller-side `upto` code lives (0034's note for the seller SDK):

- **The upstream `upto` `server` class** in `@x402/stellar` (0034 step 3): a `C...` signer behind
  the same pluggable interface as the `G...` one.
- **The Rust crate, part 2** (0140): the same, once its `upto` part exists.

Whichever ships first sets the signer interface; the other follows it.

## Implementation

- Define the signer interface in the `G...` version so that it takes the entry (or its
  preimage) and returns signed `SorobanAddressCredentials`, not a raw ed25519 signature.
- A `C...` signer: build the `HashIdPreimage::SorobanAuthorization` for the entry, have the
  wallet's signer(s) sign it, and encode the signature as the wallet's `__check_auth` expects.
  Start with one common wallet type; leave the encoding pluggable for others.
- `signatureExpirationLedger` keeps the spec's bound: no later than the client's
  `allowance_expiration_ledger`.
- Note in the docs that a failing `__check_auth` on the seller's side surfaces only at settlement,
  when the facilitator runs the enforcing simulation.

## Acceptance Criteria

- [ ] The `upto` `server` class (or 0140's crate, whichever comes first) signs the receiver
      authorization with a `C...` account through the pluggable signer
- [ ] Unit test: the signed entry matches the spec's tree byte for byte, with address credentials
      for the `C...` address and the expiry bound
- [ ] A testnet run settles a self-managed `upto` payment whose receiver authorizer is a `C...`
      account (run only with okarcz's go)
- [ ] The docs page says which wallet types are supported
