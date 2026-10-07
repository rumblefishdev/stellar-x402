# ADR 0007: Any SEP-41 token, with fees contained by one fee config, rate limits and spend budgets

- Status: accepted
- Date: 2026-10-07

## Context

Tranche 1 requires the facilitator to:

- settle any SEP-41 token;
- sponsor every fee;
- apply rate limiting.

`/settle` takes no API key, so the gate's proxy works without one.

The M1 architecture review found a fee-drain attack:

- Anyone can submit valid self-payments of 1 unit of a self-issued token.
- Each costs us up to the fee ceiling.
- A token that passes simulation but fails on chain costs the attacker nothing.
- Rotating IPs gets past a per-IP limit.

It also found that two fee ceilings disagreed:

- upstream `verify()` uses `maxTransactionFeeStroops` (default 50,000);
- the pool uses `maxFeeStroops` (default 250,000);
- a measured first-of-day settlement cost 151,550 stroops.

## Decision

- **No token allowlist.**
  - Verification doesn't depend on the token: the asset comes from `paymentRequirements`, and the
    simulated balance changes are checked.
  - `/supported` advertises scheme and network only, with `extra.areFeesSponsored: true`.
  - The test matrix covers testnet USDC, a self-issued SAC and a non-SAC SEP-41 token.
- **One fee configuration.**
  - The fee is the simulation resource fee plus our inclusion bid, at least 100 stroops. The
    client's fee is never used.
  - `maxFeeStroops` and `inclusionFeeStroops` each feed both upstream `ExactStellarScheme` and the
    pool.
  - `feeEscalation` is set by the app: interim testnet values in Tranche 1, mainnet values from
    task 0010.
- **Rate limiting.**
  - One middleware with separate budgets for `/verify`, `/settle` and `/discovery/*`; 429 when
    exceeded.
  - It is keyed by client IP, taken only from configured trusted-proxy hops.
  - An optional per-caller API key is accepted as an alternative key, not required in Tranche 1.
- **Spend budgets.**
  - Before `submit()`, `/settle` reserves the fee against a global rolling budget and against
    per-payer, per-`payTo` and per-asset budgets. When over budget it returns `success: false` and
    submits nothing.
  - A breaker per asset and per `payTo` opens after repeated on-chain failures.
  - These raise alerts: the budget nearing its limit, an open breaker, a low facilitator balance,
    quarantined channels, pending results.
- **Non-custodial.** The facilitator never holds client or seller funds and never extends credit.
  Its accounts hold only XLM for fees and channel reserves.

## Rationale

- **An allowlist would contradict "any SEP-41 token"** and add per-token config. The balance
  check on simulation is what makes a token safe to settle, not its name.
- **Two ceilings mean verify accepts payloads that settle refuses, or the reverse.** One value
  removes that class of bug.
- **IP limits alone can't stop a drain.** Budgets keyed by payer, recipient and asset bound
  what any one party can cost us, and the global budget bounds the total. The breaker stops
  repeated failures that cost us fees.
- **It belongs in Tranche 1.** The gate facilitator is public, and the same code goes to
  mainnet.

## Alternatives considered

- **A token allowlist.** Contradicts the Tranche 1 requirement. Rejected.
- **Required API keys on `/settle` in Tranche 1.** The gate proxy and early sellers would need
  keys. Deferred: the key path exists as an option.
- **IP rate limits only, budgets at mainnet.** Leaves the public testnet facilitator drainable
  and the mainnet code untested. Rejected.
- **A global budget only.** Bounds the loss but lets one attacker exhaust it for everyone.
  Rejected.

## Consequences

- A store must hold spend reservations (`SpendStore`, task 0013).
- The numeric limits are config values, set during the Tranche 1 build and tuned on mainnet.
- A legitimate seller with very high volume can hit per-`payTo` budgets; raising them is a config
  change.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-9, AD-10, AD-11, AD-18, AD-21
- [ADR 0003](0003-settlement-channel-account-pool.md),
  [Scaling x402 settlement on Stellar](../x402-settlement-scaling-en.md) (ADR-R2, ADR-R6)
- [`scheme_exact_stellar.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md)
  (fee rules)
