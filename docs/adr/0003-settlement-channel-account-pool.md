# ADR 0003: Settle each payment as its own transaction through a channel-account pool

- Status: accepted
- Date: 2026-10-07

## Context

The facilitator's `/settle` puts a client-signed payment on chain. Several Stellar rules bound
how fast it can do that:

- **One transaction per source account per ledger.** "Only one transaction (and one sequence
  number) for the same account can be consumed per ledger"
  ([Stellar docs](https://developers.stellar.org/docs/learn/fundamentals/transactions/transaction-lifecycle)).
  stellar-core rejects a new transaction from an account while one is queued, and Protocol 20
  made this network-wide
  ([SDF blog](https://stellar.org/blog/developers/proposed-changes-to-transaction-submission)).
  The 0006 bench confirmed it: of 20 transactions sent at once from one account, 1 was accepted,
  1 got `TRY_AGAIN_LATER` and 18 got `tx_bad_seq`. One account settles at most 1 payment per
  ledger, about 0.2 per second.
- **One Soroban operation per transaction.** A contract call can't share a transaction with
  other operations, so in x402 one payment is one transaction. The Stellar `exact` spec also
  requires a single `transfer` per transaction and one hash per payment.
- **A network-wide byte ceiling.** Soroban takes 266,240 B of transactions per ledger. An `upto`
  settlement is 2,516 B, so at most about 105 fit in a ledger (about 219 for `exact`), for the
  whole network.
- **Shared space on mainnet.** On 2026-10-06 mainnet used about 81% of that budget, about 98% of
  it KALE bots bidding 100–200 stroops. At a 200-stroop bid about 20 `upto` settlements per
  ledger were free on average, 13 at the median.
- **License.** The existing channel implementation is AGPL, so the pool must be our own
  ([ADR 0002](0002-independent-implementation.md)). The RFP architecture (§3.3) names this
  option (b).

## Decision

Settle every `exact` and `upto` payment as its own transaction, sent from a pool of channel
accounts (`packages/signer-pool`).

- **Channels.** Each channel is an account holding only its reserve (1.5 XLM). The facilitator
  key is its signer and its master key is disabled, so the facilitator manages one key, not N.
- **Transaction shape (`delegated-bump`).** The channel is the transaction source and supplies
  the sequence number. The facilitator is the operation source of the contract call, so its
  `require_auth` uses source-account credentials. The facilitator signs once and pays the fee
  through a fee bump; channels never pay fees.
- **One transaction pending per channel.** `ChannelPool` hands a channel to one caller at a time,
  and callers queue in arrival order when all channels are busy. The submitter tracks each
  channel's sequence number itself and reloads it only after the pending transaction is final
  or past its time bound.
- **Pipelining.** While a channel's transaction is pending, the next queued call prepares the
  next envelope for it and sends it once the first one lands.
- **A queue-aware fee bid.** The inclusion fee is a `getFeeStats` percentile and rises with the
  pool's backlog up to a configured ceiling. The app turns this on; the library default is off.
- **`pending` instead of failure.** If a transaction isn't final within its bound plus a grace
  period, `submit()` returns `pending` with the hash and keeps confirming in the background. The
  app maps this to x402's `settlement_pending` (task 0009).
- **Pool size.** Size it from the target rate: with pipelining, about 1 channel per settlement
  per ledger.

## Rationale

- **It removes the per-account limit.** N channels give about N settlements per ledger, up to
  the network ceiling, and the facilitator still holds one key.
- **It's what the x402 specs expect.** One payment, one transaction and one hash, with every
  payment isolated from the others. A bad payment can only fail itself.
- **It's non-custodial.** Funds move straight from payer to seller. The facilitator holds only
  XLM for fees, and channels hold only their reserve.
- **It's measured on testnet** (UptoProxy `CBEPV3F2…TEGY7`):
  - 0006: N channels gave N settlements per ledger up to 50; 120 channels reached 102–103 per
    ledger, the byte ceiling. One seller and many sellers performed the same.
  - 0007: 50 channels settled 50 per ledger. At 200 channels the pool held a steady 90–99 per
    ledger, with peaks of 105–110, and 0 sequence errors in every run.
  - Pipelining at 90 channels raised the mean from 50 to 64 per ledger, and 1-ledger channel
    cycles from 36% to 82%.
- **`delegated-bump` is the cheapest shape measured.** 2,516 B and about 41,000 stroops, against
  2,680 B and 49,368 stroops for the address-auth shape (spike S8), which also costs 0.55 M more
  instructions and a nonce write.

## Alternatives considered

- **A single facilitator account.** Rejected: 1 settlement per ledger.
- **A hosted channel service called over the network** (RFP §3.3 option (a)). Rejected by
  [ADR 0002](0002-independent-implementation.md): we don't use or call that code.
- **Channels bound by address auth (spike S8)** instead of the facilitator as operation source.
  Rejected: bigger and about 20% more expensive per settlement.
- **An atomic batch with bisection (A1 in the scaling analysis).** Rejected: any payer can
  poison a batch almost for free by spending their balance or using their auth entry
  elsewhere. Every failure costs a fee and at least one ledger, and it breaks the `exact` spec.
- **A try/skip batch router (A2).** Not the production path: at most about 1.6× the throughput,
  almost no fee savings, three error classes the host can't catch, and it breaks the `exact`
  spec. It stays a spike and an upstream proposal.
- **Netting on credit (B1).** Rejected: the payer can spend the funds before settlement, and a
  facilitator that pools or advances funds becomes a custodian or money remitter.
- **A deposit-backed payment channel (B2, x402 `batch-settlement`).** Not now. It is the only way
  past the network ceiling, but it needs a new contract, a Stellar binding of the spec and an
  audit (task 0008). It would send its own transactions through this pool too.

## Consequences

- Throughput is bounded by our share of the network's Soroban space: at most about 105 `upto` or
  219 `exact` per ledger, and today about 20 `upto` at a 200-stroop bid. Going past that needs
  B2.
- The pool costs 1.5 XLM of reserve per channel, and setup transactions create at most 19
  channels each (20-signature limit).
- The facilitator pays every fee, so its XLM balance must be monitored
  (`checkFacilitatorBalance`).
- We own the sequence tracking, retries and confirmation logic, and its tests. That includes
  sends with an uncertain outcome: they are resent or resolved by hash, never reported as
  failed.
- A prepared envelope is simulated before the previous transaction lands. No testnet
  settlement failed because of this, but it is unmeasured on mainnet.
- The app still has to build `settlement_pending`, a durable settlement record, the deadline
  from the client's signature and zero-amount handling (task 0009). The mainnet fee curve is
  task 0010.

## References

- Task 0007 and its testnet results:
  [0007_FEATURE_facilitator-settlement-submitter](../../lore/1-tasks/active/0007_FEATURE_facilitator-settlement-submitter.md)
- Task 0006 measurements:
  [R-testnet-throughput-measurements](../../lore/1-tasks/archive/0006_RESEARCH_upto-settlement-scaling/notes/R-testnet-throughput-measurements.md),
  [S-facilitator-scaling](../../lore/1-tasks/archive/0006_RESEARCH_upto-settlement-scaling/notes/S-facilitator-scaling.md)
- [Scaling x402 settlement on Stellar](../x402-settlement-scaling-en.md) (2026-10-06): variants
  A0–B2; this ADR records its ADR-R1 and ADR-R2 (proposed there) and its rejection of A1 and B1
- [RFP technical architecture §3.3](../rfp/x402-facilitator-bazaar-technical-architecture.md)
- Stellar docs: [Transaction lifecycle](https://developers.stellar.org/docs/learn/fundamentals/transactions/transaction-lifecycle),
  [Channel accounts](https://developers.stellar.org/docs/build/guides/transactions/channel-accounts),
  [Fee bump (CAP-15)](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0015.md)
- SDF blog: [Proposed changes to transaction submission](https://stellar.org/blog/developers/proposed-changes-to-transaction-submission)
