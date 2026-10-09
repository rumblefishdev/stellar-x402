# UptoProxy

A Soroban contract that settles x402 `upto` payments on Stellar. The client signs a ceiling once;
the facilitator it chose then settles any actual amount from 0 up to that ceiling, in one
transaction the client never pays for.

The contract is immutable: no admin, no constructor arguments, no upgrade, no pause, no
cancellation, and it never holds funds. Its only contract data is used nonces. Its instance and
WASM code are persistent ledger entries with their own TTL, and every settlement keeps them alive
(see [Availability](#availability) below). The design and its
reasoning are in [ADR 0010](../../docs/adr/0010-upto-proxy-design.md); the normative spec is
[G-upto-proxy-contract-spec](../../lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md)
(section numbers below, §N, refer to it).

## Deployments

| Network | Contract ID                                                | WASM hash                                                          |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| testnet | `CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC` | `00a06b1683557a60d2822bbab4e1fee9012e9b521d52b22a8ab22fd47cd4b79c` |

Retired testnet deployments, left to expire:

- `CDSWGHBU…HEPD` (WASM `8019c086…ed6d`): self-extending, without the cap on
  `allowance_expiration_ledger` (task 0035's first deployment).
- `CC3VX7N6…Z7OYU` (WASM `be2ba121…0b34`): the code without self-extension that the first 0004 run
  tested.

`deploy/scripts/deploy-contract.sh upto-proxy` deploys it with the WASM hash as the salt. The
contract ID follows from the deployer's address and the salt, so the same code deployed by the
same key always lands at the same address, and a code change gets a new one. Another deployer gets
another ID for the same WASM: 0006's bench ran the previous code at `CBEPV3F2…TEGY7`. The script
then extends the instance and WASM to the network's maximum TTL. Testnet resets wipe it; rerunning
the script with the same deployer restores it at the same ID. There is no mainnet deployment yet.

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

**Never sign the simulated entry blindly.** The simulation comes from an RPC or a facilitator the
client doesn't control. Compare its tree with the one above, built from the payment terms, and
refuse anything else; or skip simulation and build the entry from the terms directly. Both give
the same entry (threat model, "Blind signing by the client").

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
   `allowance_expiration_ledger > max_live_until_ledger` or
   `> sequence + MAX_ALLOWANCE_LEDGERS` (17,280) → `InvalidAllowanceExpiration`
8. `(from, nonce)` already stored → `NonceUsed`; otherwise store it in temporary storage and
   extend its TTL to `allowance_expiration_ledger`
9. `token.approve(from, UptoProxy, max_amount, allowance_expiration_ledger)`
10. if `actual_amount > 0`: `token.transfer_from(UptoProxy, from, to, actual_amount)`
11. extend the instance and WASM TTL:
    `extend_ttl_with_limits(TTL_EXTEND_TO, TTL_MIN_EXTENSION, TTL_MAX_EXTENSION)`
    (see [Availability](#availability))
12. emit `UptoSettled`

The nonce is written before the token calls. Soroban forbids re-entry anyway.

## Errors

| Code | Name                         | Meaning                                                                  |
| ---- | ---------------------------- | ------------------------------------------------------------------------ |
| 1    | `InvalidAmount`              | `max_amount <= 0` or `actual_amount < 0`                                 |
| 2    | `AmountExceedsMax`           | `actual_amount > max_amount`                                             |
| 3    | `SelfPayment`                | `from == to`                                                             |
| 4    | `NotYetValid`                | the ledger time is before `valid_after`                                  |
| 5    | `Expired`                    | the ledger time is after `deadline`, or the ledger is past the allowance |
| 6    | `InvalidAllowanceExpiration` | `allowance_expiration_ledger` is over a day ahead, or beyond the max TTL |
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
persistent contract data; the instance and code entries themselves are kept alive by step 11 of
the execution order.

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
   required amount. `from` is not the facilitator: the same address can't authorize twice in one
   call, so the host would refuse the settlement.
2. `signatureExpirationLedger == allowance_expiration_ledger`. This check is required: the host
   keeps a nonce entry for the client's signature until `signatureExpirationLedger`, the
   facilitator pays its rent, and the contract never sees that value, so nothing else bounds it.
   `deadline` is at most
   `now + maxTimeoutSeconds`; the window is open now. The allowance must last until `deadline`,
   or a settlement late in the window fails with `Expired` (#5) before the deadline has passed.
   Convert seconds to ledgers with the network's current target ledger close time, which is a
   network setting since protocol 23 (CAP-0070), not a fixed 5 s. Allow
   `allowance_expiration_ledger` from the deadline's ledger (less a margin for the estimate) up to
   `currentLedger + ceil(maxTimeoutSeconds / closeTime)` plus a small margin. An earlier expiry
   would pass verify and fail the settlement after the seller has served; a later one is refused
   because the facilitator pays rent on the nonce and the allowance until
   that ledger, so a far expiry is a cost the payer picks (threat model, "Fee inflation by
   rent"). The contract refuses anything over `MAX_ALLOWANCE_LEDGERS` (17,280 ledgers, about a
   day) ahead as a backstop, so `maxTimeoutSeconds` can't exceed about a day.
3. The nonce is unused: `is_nonce_used(from, nonce)` is `false` **and** `(from, nonce)` is not in
   the facilitator's own settled-nonce record (§8.1).
4. Simulate with `actual_amount = max_amount`, the worst case. The only balance changes are
   `from` −max and `to` +max, plus the allowance write for `(from, UptoProxy)`.

### Settle

1. Verify again, against the **signed** `max_amount`, not `requirements.amount`, which now holds
   the actual charge.
2. If the actual amount is 0, send nothing, but record `(from, nonce)` durably as settled first,
   exactly as in step 4. The response has `transaction: ""` and `amount: "0"`. Without the record,
   a second `/settle` on the same payload with a non-zero amount would pass, because the contract
   never saw the nonce. On chain the nonce stays unused until the deadline, but only this
   facilitator can settle it. The contract accepts 0 too, which uses the authorization up on chain;
   the [testnet report](../../docs/upto-proxy-testnet-report.md#cost-per-settlement) has its cost.
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

With N channels, N settlements can land per ledger; one source account allows only one. The
cost of each shape, the throughput and the limits are measured in the
[testnet report](../../docs/upto-proxy-testnet-report.md). A settlement that creates a ledger
entry or extends a TTL also pays rent, which depends on the entry's size and the length of the
extension, so the fee ceiling needs room above a normal settlement's fee.

## Availability

The instance and WASM entries expire like any persistent entry. If they were archived, every
settlement would need a restore first, paid by the facilitator and possibly above its fee
ceiling, and open authorizations are bound to this address, so a redeployment couldn't take over.
Two things keep them alive (task 0035):

- **The deploy script** extends both to the network's maximum TTL (about 180 days on testnet).
- **Every successful settlement** calls `extend_ttl_with_limits` with these constants:

  | Constant            | Ledgers | About (5 s ledgers) | Meaning                      |
  | ------------------- | ------: | ------------------- | ---------------------------- |
  | `TTL_EXTEND_TO`     | 518,400 | 30 days             | the target TTL               |
  | `TTL_MIN_EXTENSION` |     120 | 10 minutes          | smaller gains are skipped    |
  | `TTL_MAX_EXTENSION` |     720 | 1 hour              | the most one settlement adds |

  The facilitator pays the rent inside the settlement fee, never the client. It does nothing
  while the TTL is above about 30 days, so for months after a deployment it costs only the check
  (23 stroops).

**Why with limits.** Rent is about 198.8 stroops per ledger extended, almost all for the WASM
code, plus about 5,800 per extension (measured in the
[testnet report](../../docs/upto-proxy-testnet-report.md#keeping-the-contract-alive)). A plain
`extend_ttl(threshold, extend_to)` would make one settlement refill the whole gap after a quiet
period: 7 days of rent is about 24 million stroops, a hundred times the facilitator's default
250,000-stroop fee ceiling, so the facilitator would refuse a valid payment. The cap keeps the
costliest settlement near 215,000 stroops (86% of the ceiling), counting an allowance expiry at the
17,280-ledger cap. Rent the token charges in the same settlement, such as a SAC instance extending
its own TTL (116,316 stroops in task 0006), comes on top and can push a valid payment over the
ceiling, so the facilitator's ceiling for `upto` needs room for it. Below the target every
settlement extends by 720; once the TTL is at the target, the minimum keeps extensions to about
one per 10 minutes under steady traffic, so the fixed cost per extension isn't paid on every
settlement. The total rent, about 0.34 XLM a day on testnet, is the same either way.

**What isn't covered.** With fewer than about one settlement an hour, each settlement adds at most
an hour and the TTL still runs down. The deploy-time extension covers that for about 180 days; a
deployment nobody settles on for longer must be extended again by its operator, or restored
(anyone can, and since protocol 23 a settlement restores it by itself, at extra cost). The
constants are in ledgers, so a faster ledger close time shortens them in time but keeps the fee
bound. The rent rate rises with the network's total state, so the cap's margin should be checked
again before mainnet. `extend_ttl_with_limits` needs protocol 26 or later (testnet runs 29);
confirm mainnet's version before deploying there.

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
real signatures on testnet with Circle USDC, a self-issued SAC asset and the non-SAC test token.

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
7. **Expiry.** `allowance_expiration_ledger` equals `signatureExpirationLedger` and lasts until
   `deadline`; `deadline` is at most `now + maxTimeoutSeconds`. Seconds convert to ledgers with
   the network's target close time (CAP-0070), not a fixed 5 s. The facilitator refuses an expiry
   past the window, since it pays the nonce's and allowance's rent until then; the contract caps it
   at 17,280 ledgers ahead, so `maxTimeoutSeconds` is at most about a day.
8. **Verify** with `max_amount == requirements.amount`, and simulate the full ceiling.
9. **Settle** against the signed `max_amount`, with `actual_amount` set to `requirements.amount`,
   which must not exceed it.
10. **Zero amount.** No transaction, `transaction: ""`, `amount: "0"`, and the pair is recorded
    as settled (item 11).
11. **Nonce reuse.** The facilitator keeps a durable record of settled `(from, nonce)` pairs,
    zero settlements included, and refuses reuse at verify and settle, even when `is_nonce_used`
    is `false`. The record is per facilitator; reuse across facilitators is the seller's credit
    risk (threat model).
12. **Balance checks.** The settle-time simulation shows only `from` −actual and `to` +actual, plus
    the `(from, proxy)` allowance write. Events alone aren't enough for non-SAC tokens.
13. **Fees.** A fresh simulation plus a buffer; the client's fee is ignored. The fee ceiling must
    allow for rent on a first settlement and for the proxy's own extension, at most 720 ledgers
    of rent (about 149,000 stroops on testnet today).
14. **Error reasons.** One `invalid_upto_stellar_*` reason per `UptoError` code and per auth
    failure.
15. **Canonical address.** How the proxy's address is published and versioned, since every fix is a
    new deployment.
16. **Trust model.** The design ships a Soroban contract; state why (recipient binding and single
    settlement can't be enforced with SEP-41 allowances alone), as the RFP asks.
17. **Smart wallets.** Policy-based wallets must allow two contexts: `settle_upto` and `approve`.
