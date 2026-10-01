---
title: "x402 upto specs: core properties and the EVM reference"
type: research
status: mature
tags: [upto, x402, spec]
links:
  - ../sources/scheme_upto.md
  - ../sources/scheme_upto_evm.md
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Read upstream scheme_upto.md and scheme_upto_evm.md (copies in sources/)"
    spawned_from: ["notes/I-section-6-2-review-findings.md"]
---

# x402 upto specs: core properties and the EVM reference

Sources: [`scheme_upto.md`](../sources/scheme_upto.md) and
[`scheme_upto_evm.md`](../sources/scheme_upto_evm.md), fetched from `x402-foundation/x402` main
on 2026-09-30.

## Core properties (MUST, every network)

1. **Single-use.** An authorization settles at most once, at any amount. Other networks must
   provide replay protection equivalent to Permit2 nonces.
2. **Time-bound.** `validAfter` is when it becomes valid and `deadline` is when it ends. Both are
   timestamps.
3. **Recipient binding.** The recipient is bound cryptographically.
4. **Maximum enforcement.** The settled amount must be `<=` the maximum. It **MAY be 0**.
5. **Phase-dependent `amount`.** In `PaymentRequirements`, `amount` is the maximum at `/verify`
   and the actual amount at `/settle`. At settle time the facilitator re-verifies the signature
   against the **signed maximum**, not `requirements.amount`.

Out of scope: multi-settlement or streaming, recurring payments, and **open-ended allowances**.

## What the EVM reference binds (`x402UptoPermit2Proxy`)

| Field | Where it is bound | What it means for Stellar |
|---|---|---|
| token | `permit.permitted.token`, which is signed | Soroban needs `token` in the signed args (F1) |
| max | `permit.permitted.amount`, which is signed | `max_amount` goes in the signed args |
| recipient | `witness.to` | `to` goes in the signed args |
| facilitator | `witness.facilitator`, with the proxy checking the caller | `facilitator` is signed and also calls `require_auth()` (F2) |
| validAfter / deadline | the witness and Permit2 | unix seconds, signed |
| nonce | Permit2 nonce (32 bytes) | `nonce: BytesN<32>` |

- **Facilitator discovery.** The facilitator publishes its address in `/supported` under
  `extra.facilitatorAddress`, and the client puts that address into the signed payload.
- **Zero settlement.** With `amount = 0`, "no on-chain transaction is required". The
  `SettlementResponse` has `transaction: ""` and `amount: "0"`.
- **SettlementResponse.** It adds a required `amount` field holding the actual amount charged.
- **Verify checks, in order.** Signature, allowance present, balance `>=` amount, signed maximum
  equals `requirements.amount` (at verify only), time window, token and network match, then a
  simulation that settles the full `amount` as the worst case.
- **Error code.** `invalid_upto_evm_payload_settlement_exceeds_amount`. The Stellar spec will need
  its own `invalid_upto_stellar_*` codes.
- **Security notes.** The client risks the full maximum. The server has to be trusted to charge
  fairly. Short time windows limit how long an authorization is exposed.

## What this means for the Stellar design

- `token`, `to`, `facilitator`, `max_amount`, `nonce`, `valid_after` and `deadline` must all be
  covered by the client's signature. `actual_amount` must not be.
- Allowing 0 is required by the spec. A zero settlement normally produces no transaction.
- A standing, reusable allowance goes against the "open-ended allowances" exclusion. This
  supports putting `approve` inside the auth tree (S-allowance-in-auth-tree).
