---
title: "UptoProxy contract specification (v1)"
type: generation
status: mature
tags: [upto, contracts, spec]
links:
  - ../../0003_FEATURE_upto-proxy-contract/README.md
history:
  - date: "2026-09-30"
    status: developing
    who: claude
    note: "Spec drafted from S- decisions and spike evidence; awaiting okarcz approval"
    spawned_from: ["notes/S-allowance-in-auth-tree.md"]
  - date: "2026-09-30"
    status: developing
    who: claude
    note: "PR #1 review: I4 narrowed to the entry's lifetime plus facilitator nonce record (§8.1); to == proxy rejected (InvalidRecipient)"
  - date: "2026-10-01"
    status: mature
    who: okarcz
    note: "Approved: PR #1 merged into develop"
---

# UptoProxy contract specification (v1)

This is the normative spec for `contracts/upto-proxy` (task 0003). "MUST" and "MUST NOT" are
normative. Every rule points back to an S- or R- note. Anything 0003 needs that this spec does
not settle goes back to 0002 before it is coded.

## 1. Scope

The contract is one immutable Soroban contract. It settles an x402 `upto` payment: it moves
`actual_amount <= max_amount` of a SEP-41 token from `from` to `to`. It does this under one
client-signed authorization and the authorization of the bound facilitator. The contract has no
admin, constructor arguments, upgrade function, pause or fund custody (S-immutable).

## 2. Interface

```rust
pub fn settle_upto(
    env: Env,
    token: Address,                   // SEP-41 token contract
    from: Address,                    // payer; signs the client entry
    to: Address,                      // payTo
    facilitator: Address,             // must authorize this call
    max_amount: i128,                 // signed ceiling
    actual_amount: i128,              // NOT signed by the client; 0 <= actual <= max
    nonce: BytesN<32>,                // x402 nonce, client-chosen random
    valid_after: u64,                 // unix seconds, inclusive
    deadline: u64,                    // unix seconds, inclusive
    allowance_expiration_ledger: u32, // approve live_until; signed via the approve sub-invocation
) -> Result<(), UptoError>;

pub fn is_nonce_used(env: Env, from: Address, nonce: BytesN<32>) -> bool;
```

The contract MUST have no other public functions. There is no cancellation function
(S-cancellation, decided by okarcz).

## 3. Signed payload (client)

`from.require_auth_for_args` MUST receive exactly this vector, in this order and with these types:

| # | Value | ScVal |
|---|---|---|
| 0 | `token` | `Address` |
| 1 | `to` | `Address` |
| 2 | `facilitator` | `Address` |
| 3 | `max_amount` | `I128` |
| 4 | `nonce` | `Bytes` (32) |
| 5 | `valid_after` | `U64` |
| 6 | `deadline` | `U64` |

`actual_amount` and `from` MUST NOT be in it. `from` is the signer of the entry, so it is bound
already. `allowance_expiration_ledger` is bound through the sub-invocation.

### 3.1 The client's auth entry, which is the only valid shape

```
credentials: ADDRESS or ADDRESS_V2 (address = from)
  signatureExpirationLedger == allowance_expiration_ledger   (client rule; the facilitator
                                                              verifies it; the contract can't see it)
rootInvocation:
  contract = <UptoProxy>, fn = "settle_upto", args = §3 vector
  subInvocations:
    - contract = token, fn = "approve",
      args = [from, <UptoProxy>, max_amount, allowance_expiration_ledger]
      subInvocations: []
```

The client MUST NOT use its own account as the source of the draft transaction it simulates. It
would then get source-account credentials (R-soroban-auth-model). Use the facilitator address.

### 3.2 The facilitator's auth

The facilitator's entry covers `settle_upto` with all 10 real args and no sub-invocations. It uses
either `SOURCE_ACCOUNT` credentials (facilitator is the tx source) or `ADDRESS`/`ADDRESS_V2`
credentials (channel account as source). Spike S1 and S8 cover both (S-facilitator-binding).

## 4. Execution order

`settle_upto` MUST run these steps in this order. Any error aborts the call, and the host rolls
back all state.

1. `max_amount <= 0` or `actual_amount < 0` → `InvalidAmount`
2. `actual_amount > max_amount` → `AmountExceedsMax`
3. `from == to` → `SelfPayment`, and `to == current_contract_address` → `InvalidRecipient`
4. `from.require_auth_for_args(<§3 vector>)`. This MUST come before step 9 (R-soroban-auth-model).
5. `facilitator.require_auth()`
6. `now = env.ledger().timestamp()`. `now < valid_after` → `NotYetValid`, and `now > deadline` →
   `Expired`.
7. `seq = env.ledger().sequence()`. `allowance_expiration_ledger < seq` → `Expired`, and
   `allowance_expiration_ledger > env.ledger().max_live_until_ledger()` or
   `> seq + MAX_ALLOWANCE_LEDGERS` (17,280, about a day) → `InvalidAllowanceExpiration`. The cap was
   added by task 0035 (ADR 0010, D11).
8. Nonce: if `Nonce(from, nonce)` exists → `NonceUsed`. Otherwise set it in temporary storage and
   `extend_ttl(key, live_for, live_for)` with `live_for = allowance_expiration_ledger - seq`.
   Skip the extension when `live_for == 0`: the minimum temporary TTL already covers it.
9. `token.approve(from, current_contract_address, max_amount, allowance_expiration_ledger)`
10. If `actual_amount > 0`: `token.transfer_from(current_contract_address, from, to, actual_amount)`
11. Emit `UptoSettled` (§6), then return `Ok(())`.

The nonce is written in step 8, before the external token calls in steps 9 and 10. Re-entry is
impossible anyway, but the write still comes first.

## 5. Errors

```rust
#[contracterror]
#[repr(u32)]
pub enum UptoError {
    InvalidAmount = 1,
    AmountExceedsMax = 2,
    SelfPayment = 3,
    NotYetValid = 4,
    Expired = 5,
    InvalidAllowanceExpiration = 6,
    NonceUsed = 7,
    InvalidRecipient = 8,
}
```

The facilitator maps these to `invalid_upto_stellar_*` x402 error reasons. The names belong to the
spec task. Auth failures surface as host `Error(Auth, …)`, not as contract errors.

## 6. Event

```rust
#[contractevent]
pub struct UptoSettled {
    #[topic] pub token: Address,
    #[topic] pub from: Address,
    #[topic] pub to: Address,
    pub facilitator: Address,
    pub max_amount: i128,
    pub actual_amount: i128,
    pub nonce: BytesN<32>,
}
```

The fixed topic is `"upto_settled"`, and the data is a map. The event is emitted for zero
settlements too.

## 7. Storage

| Key | Tier | Value | Lifetime |
|---|---|---|---|
| `DataKey::Nonce(Address, BytesN<32>)` | temporary | `()` | until at least `allowance_expiration_ledger` (S-nonce-storage) |

After the entry expires, `is_nonce_used` returns `false` again. The contract alone does not stop a
nonce from being reused in a new payload signed later; the facilitator does (§8.1).

There is no instance or persistent storage. The contract instance and WASM entries still have a
TTL. This spec said the 0004 deploy scripts would keep it alive; they didn't (PR #12 review).
Task 0035 made the contract extend itself on every settlement and the deploy script extend each
deployment to the maximum (ADR 0010, D10).

## 8. Invariants (every one gets a test in 0003)

- **I1** Tokens move only from `from` to `to`, by exactly `actual_amount`, which is at most
  `max_amount`. The proxy's own token balance never changes.
- **I2** Nothing moves without the client's signature over the §3.1 tree. Changing any signed
  field fails auth.
- **I3** Nothing moves without the authorization of the signed `facilitator`.
- **I4** Each `(from, nonce)` settles at most once while its nonce entry lives, that is, until at
  least the `allowance_expiration_ledger` of the settlement that consumed it. A second settlement
  in that window fails with `NonceUsed`. Reuse after the entry expires is blocked off-chain (§8.1).
- **I5** Settlement happens only while `valid_after <= now <= deadline` and
  `seq <= allowance_expiration_ledger`.
- **I6** The contract calls only `approve` and `transfer_from`, and only on the signed `token`.
- **I7** There is no privileged role and no code path that changes code or configuration.

### 8.1 Facilitator obligation: reject reused nonces

The facilitator MUST keep a durable record of every `(from, nonce)` it has settled and MUST reject
a payload whose pair is in that record at verify and again at settle, even when `is_nonce_used`
returns `false`. The record MUST outlive the contract's nonce entry; the facilitator never deletes
it. Zero settlements, which send no transaction, are recorded too. This goes into
`scheme_upto_stellar.md` as a verification rule. It covers only settlements made through that
facilitator; reuse across facilitators leaves the second seller unpaid (threat model, "Seller not
paid").

## 9. Measured cost (spike, testnet, SAC token)

| Path | Fee (stroops) |
|---|---|
| Facilitator as source, `actual > 0` | ~38,600 |
| Facilitator as source, `actual = 0` | ~28,000 |
| Channel as source, plus a signed facilitator entry | ~47,300 |

The production contract (with events and extra checks) is measured again in 0003 and 0004. The
facilitator's `upto` fee ceiling must allow for the channel path.

## 10. Open items

None. Client cancellation was considered and left out of v1 (S-cancellation).

## 11. Deviations from architecture doc §6.2

Moved to [ADR 0010](../../../../../docs/adr/0010-upto-proxy-design.md#deviations-from-architecture-doc-62),
which is the canonical list. It keeps D1–D8 from this spec and adds D9 (`require_auth_for_args`
runs before `approve`).

The notes behind D1–D8: D1 F1 and S-token-scope, D2 F2 and S-facilitator-binding, D3 F3 and
S-allowance-in-auth-tree, D4 and D5 S-time-bounds-and-expiry, D6 S-nonce-storage, D7
S-zero-amount-and-edge-inputs, D8 S-immutable.
