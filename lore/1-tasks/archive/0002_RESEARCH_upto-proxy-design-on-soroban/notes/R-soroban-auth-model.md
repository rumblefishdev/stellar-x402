---
title: "Soroban authorization model as it applies to UptoProxy"
type: research
status: mature
tags: [soroban, auth, cap-71]
links:
  - https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
  - https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Verified in soroban-env-host 28.0.2 source; key points reproduced by spike unit tests and testnet"
    spawned_from: ["notes/I-section-6-2-review-findings.md"]
---

# Soroban authorization model as it applies to UptoProxy

These facts were verified in local crate sources. `H/` means `soroban-env-host-28.0.2/src/`.
Points marked **[spike]** were also reproduced by the spike, in unit tests or on testnet (see
R-testnet-spike).

## What the client signs

- `require_auth_for_args(args)` takes the contract address and function name from the current
  frame and replaces **only the args** (`H/auth.rs:747-758`, `H/host.rs:3512-3523`). A signature
  cannot be moved to another contract or function.
- The signed hash covers `network_id` (the SHA-256 of the passphrase), the nonce,
  `signatureExpirationLedger` and the **whole invocation tree, including sub-invocations**
  (`H/auth.rs:2640-2662`). V2 credentials also cover the signer's address.
- `actual_amount` is left out of the root args, so the signature does not depend on it.
  **[spike]** One signed entry was simulated with `actual = max` and settled with 37.5 of 100.

## How the tree is matched when auth is enforced

- A child `require_auth` matches a sub-invocation only after the parent node for the same address
  has matched (`H/auth.rs:1985-2012`).
- Once a root is active, a separate root entry for the same address is refused inside that call
  (`allow_matching_root = !has_active_tracker`, `H/auth.rs:1236-1270`).
- **Consequence:** `settle_upto` must call `from.require_auth_for_args(..)` **before**
  `token.approve(..)`. **[spike]** The reversed order fails against the same tree
  (`approve_before_require_auth_does_not_match_the_same_tree`).
- The approve sub-invocation must match exactly on contract, function and args
  (`H/auth.rs:704-718`). Its args must not depend on `actual_amount` or on ledger state. So the
  approve expiration ledger has to be a parameter the client signs.
- Frames that need no auth are skipped (`H/auth.rs:885-897`).

## Simulation in recording mode

- With the correct call order, simulation records one entry for `from`: the root is
  `settle_upto(<custom args>)` with one sub-invocation, `approve(from, proxy, max, exp)`.
  **[spike]** The tree printed from testnet simulation matches.
- Simulation sets the nonce randomly and `signatureExpirationLedger: 0`. The client must set the
  expiration before signing (`H/e2e_invoke.rs:621-657`).
- **If the draft transaction's source is the client itself**, the client gets
  `SOURCE_ACCOUNT` credentials (`H/auth.rs:2433-2459`). Those cannot survive the facilitator
  rebuilding the transaction with itself as source. **[spike]** Observed on testnet. The client's
  draft must use another source, such as the facilitator address from `/supported`.
- The testnet RPC (protocol 29) returned `ADDRESS` (V1) credentials in one run and `ADDRESS_V2`
  in the others. **[spike]** Both kinds settled on-chain.

## Automatic authorization for a direct caller

When P calls `T.transfer_from(spender = P, ..)` and T calls `P.require_auth()`, the check passes
with no auth entry, because P is T's **direct** caller (`H/auth.rs:1164-1196`). This is why the
proxy's `transfer_from` needs no second client signature. **[spike]** `env.auths()` shows only the
client and the facilitator.

## Built-in replay protection and expiry

- The nonce is consumed when the entry first matches. It is stored as a temporary entry owned by
  the signer, and lives until `max(signatureExpirationLedger, min temporary TTL)`. Reusing it
  fails with `Error(Auth, ExistingValue)` (`H/auth.rs:2586-2618`, `2958-3016`). **[spike]**
  Replaying S1 was rejected with exactly that error, before the contract's own nonce check ran.
- There are two expiry checks. `ledger > signatureExpirationLedger` fails. So does
  `signatureExpirationLedger > seq + max_entry_ttl - 1` (`H/ledger_info.rs:25-30`).
- A failed transaction rolls back its storage writes, so the nonce is not consumed.

## Facilitator credentials

- `facilitator.require_auth()` is satisfied by **source-account credentials** when the
  facilitator is the transaction source (`H/auth.rs:2353-2364`), with no nonce and no signature.
- It is equally satisfied by an **address-credential entry** signed by the facilitator when a
  **channel account** is the source. **[spike]** S8 settled on-chain: the channel paid the fee,
  and the facilitator paid 0 XLM.

## CAP-71 (V2 and delegate credentials)

- XDR 28 has these credential kinds: `SOURCE_ACCOUNT`, `ADDRESS`, `ADDRESS_V2` and
  `ADDRESS_WITH_DELEGATES`.
- V2 signs `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS`, which also covers the address.
- CAP-71 says it shipped in **protocol 27**. The `exact` spec says "Protocol 28 activates", which
  is inaccurate.
- The contract needs no changes. Matching does not depend on the credential kind. Only the code
  that signs (client and facilitator) must support V2.
- **JS SDK:** `@stellar/stellar-sdk` 15.x **cannot parse** `ADDRESS_V2`
  (`XdrReaderError: unknown SorobanCredentialsType member for value 2`). 17.2.0 can parse it, and
  its `authorizeEntry` signs either kind. **[spike]**
  - Follow-up for the facilitator: check which stellar-sdk version `@x402/stellar` pins.

## Contract accounts (`__check_auth`)

Matching is the same for contract accounts. The wallet's `__check_auth` gets the flattened tree,
root first:
`[settle_upto(custom args), approve(..)]` (`H/builtin_contracts/account_contract.rs:126-147`).

- So a policy-based smart wallet sees the **custom** args and has to allow both contexts.
- This is not tested in M1. It should be listed as a known limitation.

## Re-entrancy

Ordinary calls use `ContractReentryMode::Prohibited` (`H/host/frame.rs:1150-1178`). A malicious
token cannot call back into the proxy.
