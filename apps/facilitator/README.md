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
- `NETWORK=stellar:pubnet` refuses to start with `STORE=memory`: a restart would lose the
  settlement records, and there are no spend budgets or channel lease yet (0022).

## `/settle` answers

Every outcome is a 200 with an x402 `SettleResponse`. A 400 is a malformed request. A 500 is an
error of ours, such as the store failing: repeat the same request. Never sign a new payment
because of a 500, since the first one may still be settling.

`success: true` is answered once per payment: an earlier call got it, whoever made that call.
Every later call with the same payment gets `settle_exact_stellar_already_settled`, so one payment
unlocks one response.

| `errorReason`                                        | `transaction`           | Meaning                                                                        | What to do                                               |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `settlement_pending`                                 | the hash, or empty      | sent, not final yet; empty: the store couldn't say what happened               | repeat the same request (see below), or look the hash up |
| `settle_exact_stellar_already_settled`               | the hash                | settled; an earlier call already got this payment's success                    | don't serve again for this payment                       |
| `settle_exact_stellar_nonce_already_used`            | the stored hash, if any | this payer's nonce is already used by another payment, in whatever state       | refuse: the payment isn't for this request               |
| `settle_exact_stellar_timeout`                       | —                       | the settle budget ran out before anything was signed; nothing was or will be   | sign a new payment                                       |
| `settle_exact_stellar_rpc_unavailable`               | an earlier hash, if any | no RPC endpoint answered (refused, failed or timed out)                        | sign a new payment and try again later                   |
| `settle_exact_stellar_no_channel_in_time`            | —                       | every channel was busy until the deadline                                      | sign a new payment and try again later                   |
| `settle_exact_stellar_no_channels`                   | —                       | every channel is out of the pool                                               | sign a new payment and try again later                   |
| `settle_exact_stellar_fee_exceeds_maximum`           | an earlier hash, if any | the network fee rose above the facilitator's ceiling                           | sign a new payment and try again later                   |
| `settle_exact_stellar_signature_expiration_too_soon` | an earlier hash, if any | the auth expires before the pool could land it                                 | sign a new payment with a longer `maxTimeoutSeconds`     |
| `settle_exact_stellar_simulation_failed`             | an earlier hash, if any | the settlement's simulation failed, e.g. the payer's balance                   | check the payer, then sign a new payment                 |
| `settle_exact_stellar_unexpected_balance_changes`    | —                       | the transaction moves something other than the one payment                     | refuse: the payment is malformed                         |
| `settle_exact_stellar_record_write_failed`           | an earlier hash, if any | a new envelope wasn't sent: its hash couldn't be stored, or the budget ran out | sign a new payment                                       |
| a spend reason from the facilitator's limits         | —                       | the facilitator's spend limits refused it                                      | sign a new payment later; this one is ended              |
| `settle_exact_stellar_refused`                       | —                       | the spend-limit check failed with an error of ours                             | sign a new payment, and tell us                          |
| `settle_exact_stellar_transaction_failed`            | the hash                | included in a ledger, but failed                                               | sign a new payment                                       |
| `settle_exact_stellar_transaction_submission_failed` | the hash                | refused by the network before inclusion                                        | sign a new payment                                       |
| `settle_exact_stellar_transaction_expired`           | the hash                | not included before its time or ledger bound                                   | sign a new payment                                       |
| `invalid_exact_stellar_*`, `invalid_network`         | —                       | the `/verify` checks, rerun by `/settle`, refused the payment                  | fix the payment                                          |
| `unexpected_settle_error`                            | —                       | an error of ours after the claim                                               | sign a new payment, and tell us                          |

"An earlier hash, if any": a refusal after a `txBadSeq` rebuild carries the last stored hash, of an
envelope sent before it that the network refused.

A failure with no `transaction`, other than `settlement_pending`, sent nothing. The same payment
gets the same answer again, so a retry needs a new payment (a new nonce); only
`settlement_pending` is worth repeating as is. Two exceptions:

- a `…_timeout` the budget gave before the payment was claimed, during the checks, recorded
  nothing: the same payment may be sent again as it is, or a new one signed;
- a spend refusal the store couldn't record leaves the payment claimed, so a repeat after the
  budget gets `…_timeout` instead of the spend reason.

Until 0019 nothing finishes a `pending` record: every repeat of it gets `settlement_pending`
until the process restarts. Look the hash up on chain instead of repeating for long.
