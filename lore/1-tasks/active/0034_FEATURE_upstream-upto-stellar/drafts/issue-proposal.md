# Proposal: `upto` scheme on Stellar (`scheme_upto_stellar.md` + `@x402/stellar` classes)

## Problem

`upto` (authorize a maximum, settle actual usage) has EVM and SVM network specs, but none for Stellar. Stellar's x402 support today is `exact` only, so metered services on Stellar (LLM tokens, bandwidth, compute) have to either overcharge with `exact` or run their own billing outside x402.

This work answers the Stellar Community Fund RFP "x402 Facilitator with Bazaar Discovery Support" (SCF Build Award, RFP track), which asks for the `upto` scheme to be merged upstream with its `scheme_upto_stellar.md` network spec.

## Why `exact` isn't enough

`exact` on Stellar signs a `transfer(from, to, amount)` with the amount fixed at signing time. `upto` needs the amount to be chosen after the request runs, which a signed SEP-41 `transfer` can't express.

SEP-41 allowances alone don't solve it either: if the client `approve`s the facilitator, the facilitator can `transfer_from` to any recipient, any number of times, until the allowance is used up or expires. That fails `upto`'s recipient-binding and single-use properties.

## Proposed approach

A small immutable Soroban contract, **UptoProxy**, with one entry point:

```rust
settle_upto(token, from, to, facilitator, max_amount, actual_amount, nonce,
            valid_after, deadline, allowance_expiration_ledger)
```

- The **client** signs one Soroban authorization entry for `settle_upto` over everything except `from` (the signer) and `actual_amount`, with a nested `token.approve(from, proxy, max_amount, allowance_expiration_ledger)`. It never builds, signs or pays for a transaction, as in `exact`.
- The **facilitator** puts in the actual amount (`0..=max_amount`), adds its own authorization (the contract calls `facilitator.require_auth()`), and submits, paying the fees.
- The contract checks the amount, the window and a single-use `(from, nonce)`, then runs `approve` and `transfer_from` to the signed recipient. It has no admin, no upgrade path and never holds funds.

It maps to the five core properties: the nonce for single use; `valid_after` and `deadline` for time bounds; the signed `to` for recipient binding; the contract check for the maximum; and `requirements.amount` at settle time for the phase-dependent amount, as in EVM.

The draft spec is attached: <link to scheme_upto_stellar.md in our fork>.

## Status

- Contract, unit, property and real-signature tests: <https://github.com/rumblefishdev/stellar-x402/tree/develop/contracts/upto-proxy>
- Deployed on testnet (`CC3VX7N6ILD63V7FS2JA7XUDX4DMHYEJXRZDOMU7GVW76XYINOAZ7OYU`); a 49-scenario end-to-end run with 21 settlement transactions across Circle testnet USDC, a SAC asset and a non-SAC SEP-41 token: <https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/upto-proxy-testnet-report.md>
- Design record and threat model: <https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/adr/0010-upto-proxy-design.md>
- Security review / audit: <status>

## Questions for maintainers

1. **Contract location.** Should UptoProxy's source move into this repo (a new `contracts/stellar/`, next to `contracts/evm/`), or stay in our repo with the spec pinning its address and WASM hash?
2. **Payload shape.** The draft sends the signed authorization entry alone (`payload.authorization`, base64 XDR), since every signed argument can be read from it. The alternative is `exact`'s `payload.transaction` (a full transaction XDR carrying the entry), which reuses more of the `exact` parsing code but adds source, fee and sequence fields the facilitator must ignore. Which do you prefer?
3. **Proxy address.** The draft has clients and facilitators use one canonical address per network from the spec, not a requirements field, so a resource server can't point a client at another contract. Is a spec-pinned address acceptable, given that every contract fix is a new address?
4. **Review path.** One PR for the spec and one for the TypeScript classes (`mechanisms/stellar/src/upto/`, following `svm/src/upto/`), or a single PR?

We'd like a maintainer to own the review, and we're happy to coordinate through the Technical Steering Committee.

<AI-use disclosure, per CONTRIBUTING.md, if it applies>
