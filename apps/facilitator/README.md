# apps/facilitator

The x402 facilitator for Stellar: `/verify` and `/settle` for the `exact` scheme, and the
discovery routes. Design: [the M1 spine](../../docs/architecture/m1-spine.md) (AD-3, AD-6, AD-22),
[ADR 0006](../../docs/adr/0006-settlement-record.md) (the settlement record) and
[ADR 0011](../../docs/adr/0011-facilitator-hosting.md) (the settle budget and its timing).

## Settings that shape `/settle`

- `SETTLE_BUDGET_MS` (30 s by default, 1–80 s): the longest one `/settle` call takes, the checks
  and the wait for a channel included. It stays below the seller's own 90 s timeout.
- `SETTLE_TIMEOUT_MS` (20 s, or the budget when that is shorter; at least 1 s, at most the
  budget): how long a repeat of a sent payment waits for it to turn final.
- `NETWORK=stellar:pubnet` refuses to start, whatever the store: `/settle` would spend there
  with no spend budgets (0024), no rate limits (0023) and no channel lease (0025) yet.

## The store

- `STORE`: `memory` (the default, testnet only) or `postgres`. The memory store loses every
  settlement record on a restart.
- `DATABASE_URL`: a `postgres://` URL, required with `STORE=postgres` and refused without it.
- `pnpm migrate` applies the pending migrations; the service never changes the schema. Run it
  before a release that adds one. `0002_success_answered`: on a database without it, a success is
  answered once per process instead of once per payment. `0003_settlement_attempts` adds each
  hash's attempt state and bounds; hashes written before it fall back to the auth entry's expiry.

## `/settle` answers

Every outcome is a 200 with an x402 `SettleResponse`. A 400 is a malformed request. A 500 is an
error of ours, such as the store failing: repeat the same request. Never sign a new payment
because of a 500, since the first one may still be settling.

`success: true` is answered once per payment: an earlier call got it, whoever made that call.
Every later call with the same payment gets `settle_exact_stellar_already_settled`, so one payment
unlocks one response.

| `errorReason`                                        | `transaction`           | Meaning                                                                        | What to do                                                                                |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `settlement_pending`                                 | the hash, or empty      | sent, not final yet; empty: not signed yet, or the store couldn't say          | repeat the same request (see below), or look the hash up                                  |
| `settle_exact_stellar_already_settled`               | the hash                | settled; an earlier call already got this payment's success                    | don't serve again for this payment                                                        |
| `settle_exact_stellar_nonce_already_used`            | the stored hash, if any | this payer's nonce is already used by another payment, in whatever state       | refuse: the payment isn't for this request                                                |
| `settle_exact_stellar_timeout`                       | —                       | the settle budget ran out before anything was signed; nothing was or will be   | sign a new payment                                                                        |
| `settle_exact_stellar_interrupted`                   | —                       | the facilitator restarted before anything was signed; nothing was or will be   | sign a new payment                                                                        |
| `settle_exact_stellar_rpc_unavailable`               | an earlier hash, if any | no RPC endpoint answered (refused, failed or timed out)                        | sign a new payment and try again later                                                    |
| `settle_exact_stellar_no_channel_in_time`            | —                       | every channel was busy until the deadline                                      | sign a new payment and try again later                                                    |
| `settle_exact_stellar_no_channels`                   | —                       | every channel is out of the pool                                               | sign a new payment and try again later                                                    |
| `settle_exact_stellar_fee_exceeds_maximum`           | an earlier hash, if any | the network fee rose above the facilitator's ceiling                           | sign a new payment and try again later                                                    |
| `settle_exact_stellar_signature_expiration_too_soon` | an earlier hash, if any | the auth expires before the pool could land it                                 | sign a new payment with a longer `maxTimeoutSeconds`                                      |
| `settle_exact_stellar_simulation_failed`             | an earlier hash, if any | the settlement's simulation failed, e.g. the payer's balance                   | check the payer, then sign a new payment                                                  |
| `settle_exact_stellar_unexpected_balance_changes`    | an earlier hash, if any | the transaction moves something other than the one payment                     | refuse: the payment is malformed                                                          |
| `settle_exact_stellar_record_write_failed`           | an earlier hash, if any | a new envelope wasn't sent: its hash couldn't be stored, or the budget ran out | sign a new payment                                                                        |
| a spend reason from the facilitator's limits         | —                       | the facilitator's spend limits refused it                                      | sign a new payment later; this one is ended                                               |
| `settle_exact_stellar_refused`                       | —                       | the spend-limit check failed with an error of ours                             | sign a new payment, and tell us                                                           |
| `settle_exact_stellar_transaction_failed`            | the hash                | included in a ledger, but failed                                               | sign a new payment                                                                        |
| `settle_exact_stellar_transaction_submission_failed` | the hash                | refused by the network before inclusion                                        | sign a new payment                                                                        |
| `settle_exact_stellar_transaction_expired`           | the hash                | not included before its time or ledger bound                                   | sign a new payment                                                                        |
| `invalid_exact_stellar_*`, `invalid_network`         | —                       | the `/verify` checks, rerun by `/settle`, refused the payment                  | fix the payment; for `invalid_exact_stellar_payload_fee_exceeds_maximum`, try again later |
| `unexpected_settle_error`                            | an earlier hash, if any | an error of ours after the claim                                               | sign a new payment, and tell us                                                           |

"An earlier hash, if any": a refusal after a `txBadSeq` rebuild carries the last stored hash.
`transaction` is the last stored hash; it may never have reached the network.

A failure with no `transaction`, other than `settlement_pending`, sent nothing. The same payment
gets the same answer again, so a retry needs a new payment (a new nonce); only
`settlement_pending` is worth repeating as is. Three exceptions:

- a `…_timeout` the budget gave before the payment was claimed, during the checks, recorded
  nothing: the same payment may be sent again as it is, or a new one signed;
- a refusal from the checks (`invalid_exact_stellar_*`, `invalid_network`) comes before the
  claim and records nothing: the same payment may be sent again, and may succeed later.
  `invalid_exact_stellar_payload_fee_exceeds_maximum` is our own fee estimate above our ceiling,
  not a fault in the payment;
- a spend refusal the store couldn't record leaves the payment claimed, so a repeat after the
  budget gets `…_timeout` instead of the spend reason.

A `pending` record is finished by reconciliation (task 0019): the pool's late result, or a sweep
that asks the network about each of the record's hashes. A hash the network doesn't know turns
`…_transaction_expired` only once its time or ledger bound has passed, so a repeat may get
`settlement_pending` for up to that long. A live sweep also waits out the call's settle budget
first. Sweeps run at startup, when the store answers again after a failed write, and every 5
minutes; a record the RPC keeps failing on is retried 5 times, then left to the 5-minute sweep
(`reconcile_gave_up`). With `STORE=memory` a restart drops every record.

The RPC keeps only a window of history (a day by default; providers differ). A record claimed
before the oldest ledger it keeps can't be told from one that never landed, so it stays open and
is logged once as `settlement_history_gone` (counted in `settlement_history_gone_total`): check
its hashes on a block explorer or Horizon before acting on it.

After a restart `/settle` answers 503 with `Retry-After: 5` and `{"error": "reconciling"}` until
the startup sweep has tried every open record; `/verify` and `/health` answer meanwhile. A record
the RPC couldn't check is retried in the background and answers `settlement_pending` until then.
The 503 isn't an x402 settle answer: a resource server should retry the same payment after
`Retry-After` rather than show the buyer an error, since nothing was settled or refused.

A success answered while the store was down is marked answered once the store is back. After a
restart the process can't know it answered one, so a repeat may get that payment's success a
second time, at most once; no money moves twice.
