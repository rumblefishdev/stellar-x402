# UptoProxy

A Soroban contract that settles x402 `upto` payments on Stellar. The client signs a ceiling once;
the facilitator it chose then settles any actual amount from 0 up to that ceiling, in one
transaction the client never pays for.

The contract is immutable: no admin, no constructor arguments, no upgrade, no pause, no
cancellation, and it never holds funds. Its only state is used nonces. The design and its
reasoning are in [ADR 0010](../../docs/adr/0010-upto-proxy-design.md); the normative spec is
[G-upto-proxy-contract-spec](../../lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md)
(section numbers below, §N, refer to it).

## Deployments

| Network | Contract ID                                                | WASM hash                                                          |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| testnet | `CC3VX7N6ILD63V7FS2JA7XUDX4DMHYEJXRZDOMU7GVW76XYINOAZ7OYU` | `be2ba12160a7e3e1a93ed0cb457b7e93cd6ed4c725cb51aeeb87313b45dd0b34` |

`deploy/scripts/deploy-contract.sh upto-proxy` deploys it with the WASM hash as the salt, so the
same code always lands at the same address, and a code change gets a new one. Testnet resets wipe
it; rerunning the script restores it at the same ID. There is no mainnet deployment yet.

## Interface

```rust
pub fn settle_upto(
    env: Env,
    token: Address,                   // SEP-41 token contract
    from: Address,                    // payer; signs the client entry
    to: Address,                      // payTo
    facilitator: Address,             // must authorize this call
    max_amount: i128,                 // signed ceiling
    actual_amount: i128,              // not signed by the client; 0 <= actual <= max
    nonce: BytesN<32>,                // x402 nonce, random, chosen by the client
    valid_after: u64,                 // unix seconds, inclusive
    deadline: u64,                    // unix seconds, inclusive
    allowance_expiration_ledger: u32, // approve live_until; signed via the approve sub-invocation
) -> Result<(), UptoError>;

pub fn is_nonce_used(env: Env, from: Address, nonce: BytesN<32>) -> bool;
```

There are no other public functions.

## What the client signs

The client signs exactly one auth entry, with this tree (§3.1):

```
credentials: ADDRESS or ADDRESS_V2, address = from
  signatureExpirationLedger == allowance_expiration_ledger
rootInvocation:
  contract = UptoProxy, fn = "settle_upto",
  args = [token, to, facilitator, max_amount, nonce, valid_after, deadline]
  subInvocations:
    - contract = token, fn = "approve",
      args = [from, UptoProxy, max_amount, allowance_expiration_ledger]
      subInvocations: []
```

- The root args are the custom vector the contract passes to `from.require_auth_for_args`, in
  this order and with these types: `Address`, `Address`, `Address`, `I128`, `Bytes` (32), `U64`,
  `U64`.
- `actual_amount` and `from` are not in it. `from` is bound as the entry's signer, and
  `allowance_expiration_ledger` through the `approve` sub-invocation.
- Changing any signed value breaks the signature. On testnet, a changed recipient, token, ceiling
  or nonce failed with `Error(Auth, InvalidAction)`.

**Getting the entry from simulation.** Simulate a draft `settle_upto` call in recording mode with
`actual_amount = max_amount`, take the auth entry whose address is `from`, and sign it. The
draft's source must be the facilitator's address, not the client's: with the client as source,
simulation returns source-account credentials and there is nothing to sign. Recording mode runs
the whole call, so it only works for terms the contract accepts; the client also needs a balance
of at least `max_amount` for it to succeed.

## What the facilitator signs

The facilitator authorizes the full call: `settle_upto` with all ten arguments, including
`actual_amount`, and no sub-invocations (§3.2). It uses source-account credentials when it is
the operation source, as in the recommended shape below, or an `ADDRESS` / `ADDRESS_V2` entry
otherwise.

## Execution order

`settle_upto` runs these steps in order (§4). Any error rolls the whole call back.

1. `max_amount <= 0` or `actual_amount < 0` → `InvalidAmount`
2. `actual_amount > max_amount` → `AmountExceedsMax`
3. `from == to` → `SelfPayment`; `to == UptoProxy` → `InvalidRecipient`
4. `from.require_auth_for_args(<signed args>)`. It must run before `approve` in step 9, or the
   `approve` call won't match the client's sub-invocation.
5. `facilitator.require_auth()`
6. `now < valid_after` → `NotYetValid`; `now > deadline` → `Expired` (ledger timestamp)
7. `allowance_expiration_ledger < sequence` → `Expired`;
   `allowance_expiration_ledger > max_live_until_ledger` → `InvalidAllowanceExpiration`
8. `(from, nonce)` already stored → `NonceUsed`; otherwise store it in temporary storage and
   extend its TTL to `allowance_expiration_ledger`
9. `token.approve(from, UptoProxy, max_amount, allowance_expiration_ledger)`
10. if `actual_amount > 0`: `token.transfer_from(UptoProxy, from, to, actual_amount)`
11. emit `UptoSettled`

The nonce is written before the token calls. Soroban forbids re-entry anyway.

## Errors

| Code | Name                         | Meaning                                                                  |
| ---- | ---------------------------- | ------------------------------------------------------------------------ |
| 1    | `InvalidAmount`              | `max_amount <= 0` or `actual_amount < 0`                                 |
| 2    | `AmountExceedsMax`           | `actual_amount > max_amount`                                             |
| 3    | `SelfPayment`                | `from == to`                                                             |
| 4    | `NotYetValid`                | the ledger time is before `valid_after`                                  |
| 5    | `Expired`                    | the ledger time is after `deadline`, or the ledger is past the allowance |
| 6    | `InvalidAllowanceExpiration` | `allowance_expiration_ledger` is beyond the network's maximum TTL        |
| 7    | `NonceUsed`                  | `(from, nonce)` was already settled and its entry is still live          |
| 8    | `InvalidRecipient`           | `to` is the proxy itself                                                 |

Auth failures are host errors, not contract errors:

- `Error(Auth, ExistingValue)`: the signed entry was already used (Soroban's own replay check).
- `Error(Auth, InvalidAction)`: the call doesn't match a signature, for example a different
  facilitator or a changed signed value.

The facilitator maps both kinds to x402 error reasons. Their names (`invalid_upto_stellar_*`)
belong to `scheme_upto_stellar.md`.

## Event

`UptoSettled` is emitted on every successful settlement, zero settlements included:

- topics: `"upto_settled"`, `token`, `from`, `to`
- data (a map): `facilitator`, `max_amount`, `actual_amount`, `nonce`

## Storage

| Key                                   | Tier      | Value | Lifetime                                     |
| ------------------------------------- | --------- | ----- | -------------------------------------------- |
| `DataKey::Nonce(Address, BytesN<32>)` | temporary | `()`  | until at least `allowance_expiration_ledger` |

After the entry expires, `is_nonce_used` returns `false` again. The contract alone doesn't stop
the same nonce in a payload signed later; the facilitator does (below). There is no instance or
persistent storage.

## Invariants

Every invariant has a test in `src/test/` (§8):

- **I1** Tokens move only from `from` to `to`, by exactly `actual_amount <= max_amount`. The
  proxy's own balance never changes.
- **I2** Nothing moves without the client's signature over the tree above.
- **I3** Nothing moves without the authorization of the signed `facilitator`.
- **I4** Each `(from, nonce)` settles at most once while its entry lives.
- **I5** Settlement happens only while `valid_after <= now <= deadline` and the ledger is at or
  before `allowance_expiration_ledger`.
- **I6** The contract calls only `approve` and `transfer_from`, and only on the signed `token`.
- **I7** There is no privileged role and no way to change code or configuration.

## Facilitator guide

### Verify

1. The client's entry has `ADDRESS` or `ADDRESS_V2` credentials for `from`, and its tree is
   exactly the one above for the payment terms: the proxy is the canonical one, `token` is the
   required asset, `to` is `payTo`, `facilitator` is this facilitator, `max_amount` equals the
   required amount.
2. `signatureExpirationLedger == allowance_expiration_ledger`, at most
   `currentLedger + ceil(maxTimeoutSeconds / 5)`; `deadline` is at most
   `now + maxTimeoutSeconds`; the window is open now.
3. The nonce is unused: `is_nonce_used(from, nonce)` is `false` **and** `(from, nonce)` is not in
   the facilitator's own settled-nonce record (§8.1).
4. Simulate with `actual_amount = max_amount`, the worst case. The only balance changes are
   `from` −max and `to` +max, plus the allowance write for `(from, UptoProxy)`.

### Settle

1. Verify again, against the **signed** `max_amount`, not `requirements.amount`, which now holds
   the actual charge.
2. If the actual amount is 0, send nothing: the response has `transaction: ""` and `amount: "0"`.
   The client's nonce stays unused until its deadline. The contract accepts 0 too, which uses the
   authorization up explicitly; on testnet that costs about 30,000 stroops.
3. Build `settle_upto` with the actual amount, the client's signed entry unchanged, and the
   facilitator's own entry. Re-simulate in enforcing mode and check that the client's tree is
   unchanged and the balance changes are `from` −actual and `to` +actual. A non-SAC token may
   emit other events or charge transfer fees, so check the balances, not only the events.
4. Record `(from, nonce)` durably and never delete it, then submit.

### Recommended submission shape

Submit in the `delegated-bump` shape ([ADR 0003](../../docs/adr/0003-settlement-channel-account-pool.md)):
a channel account is the transaction source, the facilitator is the operation source (so its
authorization is source-account credentials) and pays a fee bump. Each channel's master key is
disabled and the facilitator key is its only signer. `packages/signer-pool`'s
`SettlementSubmitter` builds this shape.

Measured in 0006 against the same contract code:

| Shape                                                                | Size        | Fee charged (stroops) |
| -------------------------------------------------------------------- | ----------- | --------------------- |
| Facilitator as transaction source                                    | 2,352 B     | 40,709                |
| **Channel source, facilitator as op source, fee bump (recommended)** | **2,516 B** | **40,965**            |
| Channel source, facilitator address auth entry                       | 2,680 B     | 49,368                |

With N channels, N settlements can land per ledger; one source account allows only one. The
first settlement that creates a ledger entry also pays its rent, up to about 150,000 stroops, so
the fee ceiling must allow for it. Costs and limits are in the
[testnet report](../../docs/upto-proxy-testnet-report.md).

## Build and test

From the repo root:

```sh
pnpm contracts:build       # every crate in contracts/, release WASM
pnpm contracts:test        # unit, property and real-signature tests
pnpm contracts:test:wasm   # tests against the release WASM (needs stellar-cli)
pnpm contracts:e2e         # the on-chain suite on testnet (see e2e/README.md)
```

The mocked-auth tests run against both a Stellar Asset Contract and the non-SAC SEP-41 token in
`contracts/test-token`; the real-signature tests use the test token, and the e2e suite covers
real signatures with the SAC and Circle USDC.

## Input for `scheme_upto_stellar.md`

The rules the Stellar network spec needs, beyond the contract itself. Writing and upstreaming the
spec is task 0034.

1. **Payload.** The client's signed auth entry for `settle_upto` with the tree above. The wire
   format (for example, reusing `exact`'s `payload.transaction` with `actual_amount` at index 5)
   is still open.
2. **`/supported`.** The facilitator publishes its address under `extra.facilitatorAddress` and
   the canonical proxy ID, which the client binds into its signature.
3. **The client's draft simulation** uses the facilitator's address as source, never its own.
4. **Credentials.** The client's entry uses `ADDRESS` or `ADDRESS_V2`; never source-account
   credentials.
5. **Exactly one sub-invocation** in the client's tree, where `exact` allows none:
   `token.approve(from, proxy, max_amount, allowance_expiration_ledger)`.
6. **The facilitator in auth entries.** Narrow `exact`'s rule: the facilitator must not appear in
   any **client-signed** entry except as the signed `facilitator` value, and it must provide its
   own authorization for the call.
7. **Expiry.** `allowance_expiration_ledger` equals `signatureExpirationLedger` and is at most
   `currentLedger + ceil(maxTimeoutSeconds / 5)`; `deadline` is at most `now + maxTimeoutSeconds`.
8. **Verify** with `max_amount == requirements.amount`, and simulate the full ceiling.
9. **Settle** against the signed `max_amount`, with `actual_amount` set to `requirements.amount`,
   which must not exceed it.
10. **Zero amount.** No transaction, `transaction: ""`, `amount: "0"`.
11. **Nonce reuse.** The facilitator keeps a durable record of settled `(from, nonce)` pairs and
    refuses reuse at verify and settle, even when `is_nonce_used` is `false`.
12. **Balance checks.** The settle-time simulation shows only `from` −actual and `to` +actual, plus
    the `(from, proxy)` allowance write. Events alone aren't enough for non-SAC tokens.
13. **Fees.** A fresh simulation plus a buffer; the client's fee is ignored. The fee ceiling must
    allow for rent on a first settlement.
14. **Error reasons.** One `invalid_upto_stellar_*` reason per `UptoError` code and per auth
    failure.
15. **Canonical address.** How the proxy's address is published and versioned, since every fix is a
    new deployment.
16. **Trust model.** The design ships a Soroban contract; state why (recipient binding and single
    settlement can't be enforced with SEP-41 allowances alone), as the RFP asks.
17. **Smart wallets.** Policy-based wallets must allow two contexts: `settle_upto` and `approve`.
