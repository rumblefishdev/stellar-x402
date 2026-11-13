# ADR 0007: Any SEP-41 token, with fees contained by one fee config, rate limits and spend budgets

- Status: accepted
- Date: 2026-10-07, amended 2026-10-14 (task 0018: the bid counts twice), 2026-10-29 (task 0066:
  restore rent), 2026-10-30 (task 0024: payer proof, budget tiers, attributed breakers, what
  the budgets bound), 2026-11-03 (task 0024: API keys on pubnet, and the floor at 5 XLM for
  task 0027's alarms) and 2026-11-13 (task 0105: how a key is checked and counted)

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
  - The pool settles under a fee bump, where the inner transaction and the bump each pay the bid
    (CAP-15), so the total is the resource fee plus twice the bid. Upstream's
    `inclusionFeeStroops` is twice the bid, so `/verify` refuses what the pool would (spine AD-10).
  - `maxFeeStroops` and `inclusionFeeStroops` each feed both upstream `ExactStellarScheme` and the
    pool.
  - Restore rent counts toward the ceiling (task 0066): since Protocol 23 a transaction restores
    the archived entries it touches and pays their rent in its resource fee. Above the ceiling the
    payment is refused and the message names the entries; below it the facilitator pays, as it
    pays any rent.
  - `feeEscalation` is set by the app: interim testnet values in Tranche 1, mainnet values from
    task 0010.
- **Rate limiting.**
  - One middleware with separate budgets for `/verify`, `/settle` and `/discovery/*`; 429 when
    exceeded.
  - It is keyed by client IP, taken only from configured trusted-proxy hops.
  - An optional per-caller API key is accepted as an alternative key, not required in Tranche 1.
    _Since 2026-11-03:_ required on pubnet, ignored on testnet (below). _Since 2026-11-13:_ a
    request with a key is counted by the key's owner, and `/verify` and `/settle` read the body
    before they count (below).
- **Spend budgets** (as amended on 2026-10-30, below).
  - Before `submit()`, `/settle` reserves the fee against a global rolling budget and against
    per-payer, per-`payTo` and per-asset budgets. When over budget it returns `success: false` and
    submits nothing.
  - Breakers per payer, per `payTo` and per wasm asset open after repeated on-chain failures
    attributed to them.
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
  keys. Deferred: the key path exists as an option. _Since 2026-11-03:_ adopted for pubnet (M2),
  see the amendment below; Tranche 1 is testnet only.
- **IP rate limits only, budgets at mainnet.** Leaves the public testnet facilitator drainable
  and the mainnet code untested. Rejected.
- **A global budget only.** Bounds the loss but lets one attacker exhaust it for everyone.
  Rejected.

## Consequences

- A store must hold spend reservations (`SpendStore`, task 0013).
- The numeric limits are config values, set during the Tranche 1 build and tuned on mainnet.
- A legitimate seller with very high volume can hit per-`payTo` budgets; raising them is a config
  change.

## Amendment 2026-10-30 (task 0024)

Task 0024 built the spend budgets and the breakers
([S-design](../../lore/1-tasks/archive/0024_FEATURE_spend-budgets-and-breakers/notes/S-design.md)).
It found that the decision above bound less than it said, and changed it as follows.

- **The payer is proven.** Upstream checks only that the payer's auth entry is signed, and Soroban
  checks it only when `require_auth` uses it. A wasm token whose `transfer` never calls
  `from.require_auth()` settled on testnet with any `from`, so per-payer budgets bound nothing for
  it. `/settle` now requires the payer's nonce key in the settlement simulation's read-write
  footprint, which the host writes only for an auth entry it used, and refuses otherwise
  (`settle_exact_stellar_payer_not_authorized`), before anything is signed. `/verify` doesn't run
  this check.
- **One balance is spent once at a time.** At most one settlement per payer and asset is in
  flight, so N payments from one balance can't all pass simulation and fail on chain at our fee.
- **Budgets come in two tiers.** A known asset (the configured SAC, USDC) gets a high per-asset
  budget. Every other token, a self-issued SAC as much as a wasm token, gets a low one, all of them
  share a `tier:other` budget, and a payer has a budget of its own in each. Anyone can mint such a
  token, so junk tokens can't spend what USDC sellers need. This limits spend, not acceptance: the
  "no allowlist" decision holds.
- **Breakers are attributed.** A breaker counts only included, charged failures, against the party
  at fault: the payer, the `payTo`, or a wasm token. A SAC's code is the host's, so a SAC never has
  a breaker, and a failure that is ours (a resource limit on a SAC, with a G-account payer) counts
  against nobody. A payment whose nonce someone used first (a seller who submitted the buyer's
  payload itself) counts against nobody either. `payTo` is blamed only for a known asset's SAC
  error naming it; in another token that error may be staged by whoever issued the token, so the
  payer is blamed. So a failure can't close USDC or another seller's `payTo`; a wasm token's payers
  can together close that token's breaker, which hurts only that token. The thresholds are fixed
  in code, not config.
- **The fee account has a floor.** `/settle` refuses while its spendable balance is below 5 XLM,
  and before it has read one. 5 XLM covers the fees in flight, about 1.25 XLM at 50 channels, and
  sits below ADR 0013's alarms at 25 and 10 XLM, so they fire before settlement stops.
- **Per-party budgets are Sybil-weak.** Addresses are free, so per-payer and per-`payTo` budgets
  bound one identity, not one attacker. The global and per-asset budgets bound the total loss. A
  `payTo` budget counts every payment to that seller, so payers who are not the seller can use it
  up: Sybil payers in USDC can exhaust a chosen seller's USDC `payTo` budget, an accepted residual.
  Payments in other tokens count in a `payTo` budget of their own per token, so a junk token can't
  use up a seller's USDC one.
- **Shared budgets bound loss, not availability.** Self-payments from many cheap addresses can use
  up `asset:USDC` (about 13 payers and 3 `payTo`s at the defaults) and refuse USDC for every
  seller until the window rolls. Accepted for Tranche 1: the loss stops at the budgets, without a
  top-up, where with no budget it would empty the float. Until callers are authenticated with fee
  budgets of their own, the shared budgets are an availability lever an attacker can pull, so
  `stellar:pubnet` stays refused until then (the amendment below), as well as until 0090.

The "Rationale" above still holds for the global budget. For the per-party ones, read "bound what
any one party can cost us" as "bound what any one address can cost us".

## Amendment 2026-11-03 (task 0024): API keys on pubnet

Decided by akot after 0024's analysis of the shared budgets: nobody in the
[facilitator survey](../../lore/1-tasks/archive/0024_FEATURE_spend-budgets-and-breakers/notes/R-facilitator-survey.md)
with an open `/settle` that pays fees for any payer closed that attack without an identity that
costs something, or a price. No requirement asks for an open `/settle` on mainnet: the RFP asks for
a free testnet, configurable mainnet pricing and documented caller authentication, and the keyless
"gate proxy" is our own conformance harness on testnet (task 0028).

- **Pubnet requires an API key** on `/verify` and `/settle` (`Authorization: Bearer`, task 0105).
  `/supported` and `/discovery/*` stay open.
- **Keys come from our portal after Discord sign-in**, one per Discord account in the Stellar
  Developers server, as stellar-prices-api issues its keys (task 0106).
- **Each account has a free quota and a fee budget of its own**, on the model of Coinbase CDP
  (1,000 settlements a month), apart from the shared asset and tier budgets; all free quotas
  share one budget, and `global` still bounds the total (task 0107).
- **Charging past the quota comes later** (task 0108, $0.001 a settlement on CDP's model, the
  price in config) and doesn't block pubnet: until then the operator raises an account's limit by
  hand. Prepaid funds or an invoice would change the "never holds … funds and never extends
  credit" line above, so 0108 decides how.
- **Testnet ignores a key**: it stays free and open, the gate's harness calls as before, and the
  shared-budget residual stays accepted there.
- **Mainnet ships in M2**, so none of this is in Tranche 1. `stellar:pubnet` is refused until
  0090, 0105 and 0107 land, with 0027 and 0048 from ADR 0013.

## Amendment 2026-11-13 (task 0105): how a key is checked and counted

Task 0105 built the key on `/verify` and `/settle`. Decided by akot with it:

- **The rule follows the request's network**, `paymentRequirements.network`, not the process's
  `NETWORK`: one process serves both networks (task 0126). The network is in the body, so both
  routes now read the body, within the body limit, before they count the request. A client over
  its budget costs a parse of at most that limit where it cost nothing; a body that names no
  network counts under the client's IP, as before.
- **A revocation holds from the next request.** The registry is read on every request that needs
  a key, one primary-key lookup, and nothing caches it: the limiter already writes to the store
  on every request, and a cache would leave a leaked key working on some instances for its
  lifetime.
- **The registry holds a key's SHA-256, its owner and its state**, never the key. A key is 32
  random bytes, so the hash needs no salt and can't be turned back into the key.
- **The limiter counts by the key's owner, not by the key**, and the spend policy gets the owner
  (task 0107). stellar-prices-api counts usage per key, in AWS, so there a replaced key has to
  wait for the next quota period, or a new key would be a new quota; counted by owner, a replaced
  key continues the count.
- **A request refused for its key counts nowhere**, neither under a key nor under its IP. Counted
  by IP, one caller without a key could use up the budget of every seller behind its address
  (task 0060). The cost is that such requests are unthrottled here: each is a body parse and, for
  a well-formed key, one registry read. The edge (Cloudflare) is the control for a flood of them
  (threat model, "API keys").

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-9, AD-10, AD-11, AD-18, AD-21
- [ADR 0003](0003-settlement-channel-account-pool.md),
  [Scaling x402 settlement on Stellar](../x402-settlement-scaling-en.md) (ADR-R2, ADR-R6)
- [`scheme_exact_stellar.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md)
  (fee rules)
