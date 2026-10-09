# ADR 0010: UptoProxy, the Soroban contract behind `upto` on Stellar

- Status: accepted
- Date: 2026-10-08, amended 2026-10-09 (task 0035: D10, self-extension; D11, expiry cap)

## Context

The x402 `upto` scheme lets a client authorize a ceiling and the seller charge the actual usage
afterwards. Its core spec requires five properties on every network: single use, time bounds,
recipient binding, the maximum enforced (the amount MAY be 0), and an amount that is the maximum
at `/verify` and the actual charge at `/settle`. Open-ended allowances are out of scope. The EVM
binding settles through `x402UptoPermit2Proxy`, which binds the token, the ceiling, the
recipient and the facilitator in a Permit2 witness.

Stellar's `exact` scheme can't express a ceiling: `require_auth()` binds a signature to the
literal call, so a signed `transfer(from, to, amount)` authorizes that one amount only.

Section 6.2 of the RFP architecture doc
([`x402-facilitator-bazaar-technical-architecture.md`](../rfp/x402-facilitator-bazaar-technical-architecture.md#62-design))
proposed a proxy contract using `require_auth_for_args` with a separate client `approve`. Task
0002 reviewed that design, tested it on testnet in eight spikes, and wrote the normative spec
([G-upto-proxy-contract-spec](../../lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md)).
Task 0003 built it (`contracts/upto-proxy`), and 0004 ran it on testnet with three tokens.

## Decision

One immutable contract, `UptoProxy`, settles each `upto` payment in one transaction:

```rust
settle_upto(token, from, to, facilitator, max_amount, actual_amount, nonce,
            valid_after, deadline, allowance_expiration_ledger) -> Result<(), UptoError>
is_nonce_used(from, nonce) -> bool
```

- **One client signature.** The client signs one auth entry. Its root is `settle_upto` with
  custom args `[token, to, facilitator, max_amount, nonce, valid_after, deadline]`, through
  `require_auth_for_args`, and its only sub-invocation is
  `token.approve(from, proxy, max_amount, allowance_expiration_ledger)`. `actual_amount` is not
  signed; the contract checks `0 <= actual_amount <= max_amount`.
- **The proxy pulls the actual amount.** After the client's auth and the `approve`, the proxy
  calls `token.transfer_from(proxy, from, to, actual_amount)`. As the spender calling for
  itself, it needs no second client signature. A zero amount skips the transfer.
- **The facilitator is bound.** `facilitator` is signed by the client, and the contract calls
  `facilitator.require_auth()`. The facilitator's own authorization covers every argument,
  including `actual_amount`.
- **Two layers of replay protection.** Soroban makes each signed auth entry single-use. On top of
  that, the contract stores `(from, nonce)` in temporary storage until at least
  `allowance_expiration_ledger`, and refuses a second settlement with `NonceUsed`. After the
  entry expires, the facilitator's durable record of settled pairs refuses reuse (spec §8.1).
- **Time bounds.** `valid_after` and `deadline` are unix seconds, inclusive, checked against the
  ledger timestamp. `allowance_expiration_ledger` bounds the allowance and the nonce entry, and
  must equal the client entry's `signatureExpirationLedger`. It may be at most 17,280 ledgers
  (about a day) ahead (D11).
- **Any SEP-41 token.** There is no allowlist. Which tokens to accept is facilitator policy,
  published in `/supported`.
- **No admin.** No constructor arguments, upgrade, pause, cancellation or held funds. A fix is a
  new deployment at a new address.
- **Typed errors and an event.** `UptoError` codes 1–8, and an `upto_settled` event on every
  settlement, zero included.
- **It keeps itself alive.** Every successful settlement extends the instance and WASM TTL with
  `extend_ttl_with_limits(518_400, 120, 720)`, and the deploy script starts each deployment at
  the network's maximum TTL (D10).
- **One payment per transaction.** There is no batch entry point. Throughput comes from channel
  accounts ([ADR 0003](0003-settlement-channel-account-pool.md)).

The [contract README](../../contracts/upto-proxy/README.md) documents the interface, the auth tree,
errors, events and invariants.

### Deviations from architecture doc §6.2

This is the canonical list. The contract spec's §11 points here; D9 was found after the spec was
written.

| #   | §6.2                                                | This design                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No `token` parameter                                | `token` is the first parameter and is signed                                                                           | The contract must know which token to move, and an unsigned token lets a facilitator settle in any token the payer has approved to the proxy. EVM signs it too.                                                                                                                                                                                                                                                                                                              |
| D2  | `facilitator` signed but never checked              | `facilitator.require_auth()`                                                                                           | Without it, anyone holding the client's entry could settle first with 1 stroop and cheat the seller. Spike S5: another submitter fails with `Error(Auth, InvalidAction)`.                                                                                                                                                                                                                                                                                                    |
| D3  | The client grants a separate `approve`              | `approve` is a sub-invocation of the same auth entry                                                                   | A separate `approve` is a second transaction the client would pay for, concurrent payments overwrite each other's allowance, and a standing allowance comes close to the spec's "open-ended allowances" exclusion.                                                                                                                                                                                                                                                           |
| D4  | None                                                | An `allowance_expiration_ledger` parameter                                                                             | `approve` needs its expiry when the client signs, and there is no fixed mapping from seconds to ledgers, so it is passed in and signed through the sub-invocation.                                                                                                                                                                                                                                                                                                           |
| D5  | Time unit not set                                   | Unix seconds, inclusive bounds                                                                                         | x402 and EVM semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D6  | Nonce storage not set                               | Temporary storage keyed `(from, nonce)`, plus the `is_nonce_used` view                                                 | The entry only has to outlive the allowance; temporary storage costs less rent than persistent and expires on its own.                                                                                                                                                                                                                                                                                                                                                       |
| D7  | None                                                | Zero settles without a transfer; `from == to` and `to == proxy` are refused                                            | The spec allows 0; a self-payment would add fake Bazaar volume; tokens paid to the proxy would be locked for good.                                                                                                                                                                                                                                                                                                                                                           |
| D8  | None                                                | Immutable, typed errors, `UptoSettled` event                                                                           | Clients sign against a fixed address, so an admin could redirect every open authorization.                                                                                                                                                                                                                                                                                                                                                                                   |
| D9  | `require_auth_for_args` and `approve` order not set | `require_auth_for_args` runs before `approve`                                                                          | Soroban matches the `approve` call as a sub-invocation only after the parent frame has authorized `from` (finding F7).                                                                                                                                                                                                                                                                                                                                                       |
| D10 | Instance TTL not addressed                          | Each settlement calls `extend_ttl_with_limits(518_400, 120, 720)`; the deploy script extends to the network maximum    | An archived proxy makes every settlement pay a restore, and open authorizations can't move to a new address. The cap is required: rent is 198.8 stroops per ledger, so an uncapped refill after a quiet period (7 days: 24 million stroops) exceeds the facilitator's fee ceiling and gets a valid payment refused. 720 ledgers keeps the costliest settlement near 77% of 250,000; 120 limits extensions to one per 10 minutes under steady traffic. Measured in task 0035. |
| D11 | Allowance expiry bounded only by the network        | `allowance_expiration_ledger` at most `sequence + 17_280` (`MAX_ALLOWANCE_LEDGERS`), else `InvalidAllowanceExpiration` | The payer picks the expiry and the facilitator pays temporary rent on the nonce and the allowance until then: 1.3 stroops per ledger on testnet, so the network's maximum (about 180 days) costs 3.9 million stroops. The facilitator's `/verify` holds expiries to the payment window; the cap is defence in depth that bounds the cost to about 25,000 stroops if it doesn't. A day leaves room for any realistic `maxTimeoutSeconds`. Found in the 0035 security review.  |

## Rationale

- **It meets all five core properties** with Soroban primitives: the nonce for single use, the
  signed window for time bounds, the signed `to` for recipient binding, the contract check for
  the maximum, and an `actual_amount` that is supplied only at settlement.
- **The client pays no settlement fees.** It signs one auth entry; the facilitator pays the fee.
  The 0004 testnet run left the client's XLM balance unchanged across every scenario.
- **Concurrent payments don't interfere.** `approve` and `transfer_from` run in the same
  invocation. 0004 settled two open authorizations from one payer in the same ledger.
- **The payer needs the full ceiling at verify and only the actual amount at settle.** The
  client's draft simulation and `/verify` simulate `actual_amount = max_amount`, so the payer must
  hold the ceiling when it pays. At settlement, `transfer_from` pulls only `actual_amount`, so
  spending part of the balance in between doesn't fail the settlement as long as the actual
  amount is still there.
- **It mirrors the EVM reference**, so `scheme_upto_stellar.md` can follow `scheme_upto_evm.md`
  closely.

## Alternatives considered

- **A separate `approve` transaction, as §6.2 is written.** Rejected: see D3.
- **Escrow** (pull the ceiling, pay the actual amount, refund the rest). Rejected: the payer's
  ceiling would be locked from payment to settlement instead of only checked at verify, and each
  payment makes three transfers instead of one.
- **Ledger numbers for the whole window.** Consistent with Stellar, but departs from x402
  semantics. Rejected by okarcz.
- **Persistent nonce storage.** Needs rent or restoration and gives nothing once the allowance has
  expired. Rejected.
- **Relying on the auth-entry nonce alone.** Rejected: it gives no on-chain "already settled"
  check and no defence against a client that signs two entries with the same x402 nonce.
- **A token allowlist.** Needs an admin or a deployment per asset. Rejected.
- **An admin or upgrade path.** Rejected: see D8.
- **A keeper job instead of self-extension** (a scheduled script with its own key extends the
  TTL). Considered in 0035. It costs the same rent and keeps settlement fees flat, but every
  deployment then needs an operator. Self-extension makes the contract keep itself alive while it
  is used, paid by the facilitators that use it; the deploy-time extension covers quiet periods.
- **Uncapped `extend_ttl(threshold, extend_to)`.** Rejected: see D10. One settlement would pay to
  refill the whole gap; the 0035 measurement showed 24 million stroops for 7 days.
- **A `cancel(from, nonce)` entry point.** Rejected for v1 by okarcz: authorizations expire within
  `maxTimeoutSeconds`, cancelling would cost the client a transaction, and neither upstream spec
  has one. It would have to be added before the mainnet deployment.
- **A batch entry point.** Rejected for v1: a contract-call transaction holds one operation,
  batching saves at most 1.5–2× in resources, and one bad entry reverts the batch. See
  0003's S-batching-and-throughput and 0006.

## Consequences

- **A leftover allowance.** After a settlement the proxy keeps `max_amount - actual_amount` of
  allowance until `allowance_expiration_ledger`. Only the proxy can spend it, and only under a new
  client signature with an unused nonce. The [threat model](../threat-model.md#upto-contract)
  covers it.
- **Facilitator obligations.** The facilitator keeps a durable record of settled `(from, nonce)`
  pairs, zero settlements included, and refuses reuse at verify and settle (spec §8.1).
- **The `exact` rules need narrowing for `upto`.** "The facilitator must not appear in any auth
  entry" becomes "in no client-signed entry, except as the signed `facilitator` value"; the client
  tree has one sub-invocation instead of none.
- **Facilitators pay to keep the proxy alive.** About 0.34 XLM of rent a day on testnet, paid by
  whichever settlement extends, at most once per 10 minutes and at most 720 ledgers (about 149,000
  stroops) at a time. Whichever facilitator settles at that moment pays for everyone; the spec
  should say so. The cap's margin under the fee ceiling depends on the rent rate and must be
  checked again before mainnet.
- **Windows of at most a day.** D11 limits `maxTimeoutSeconds` for `upto` on this deployment to
  about a day (17,280 ledgers at 5 s). A longer window needs a new deployment.
- **A fix means a new address.** `scheme_upto_stellar.md` must say how the canonical address is
  published and versioned.
- **Smart wallets** with per-context policies must allow two contexts: `settle_upto` and
  `approve`.
- **One payment is one transaction.** `upto` can't exceed the network's share of ledger capacity
  (about 105 settlements per ledger on testnet). Higher rates need off-chain aggregation or a
  `batch-settlement` binding (0008).
- **Fees.** The [testnet report](../upto-proxy-testnet-report.md#cost-per-settlement) has the
  measured cost of a settlement and of a zero settlement. A settlement that creates a ledger entry
  or extends a TTL also pays rent, so the fee ceiling (`maxFeeStroops`, 250,000 by default,
  [ADR 0007](0007-fee-abuse-containment.md)) must leave room above a normal settlement.

## References

- [UptoProxy contract spec](../../lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md) and the 0002 decision notes (`S-*`)
- [Contract README](../../contracts/upto-proxy/README.md)
- [Testnet report](../upto-proxy-testnet-report.md)
- [ADR 0003](0003-settlement-channel-account-pool.md): channel accounts and the `delegated-bump` shape
- [`scheme_upto.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md)
  and [`scheme_upto_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md)
