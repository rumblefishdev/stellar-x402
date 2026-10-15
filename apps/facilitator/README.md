# apps/facilitator

The x402 facilitator for Stellar: `/verify` and `/settle` for the `exact` scheme, and the
discovery routes. Design: [the M1 spine](../../docs/architecture/m1-spine.md) (AD-3, AD-6, AD-22)
and [ADR 0006](../../docs/adr/0006-settlement-record.md).

## `/settle` answers

Every outcome is a 200 with an x402 `SettleResponse`. A 400 is a malformed request. A 500 is an
error of ours before the payment was claimed, so nothing was sent for it.

`success: true` is answered once per payment. A repeat of the same request after that gets
`settle_exact_stellar_already_settled`, so one payment unlocks one response.

| `errorReason`                                        | `transaction`    | Meaning                                                                | What to do                                           |
| ---------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `settlement_pending`                                 | the hash         | sent, not final yet                                                    | wait: repeat the same request, or look the hash up   |
| `settle_exact_stellar_already_settled`               | the hash         | settled, and its success was already answered                          | don't serve again: the payment was served once       |
| `settle_exact_stellar_nonce_already_used`            | the hash, if any | this payment was settled for another request                           | refuse: the payment isn't for this request           |
| `settle_exact_stellar_timeout`                       | —                | the settle budget ran out before anything was signed; it never will be | sign a new payment                                   |
| `settle_exact_stellar_rpc_unavailable`               | —                | no RPC endpoint answered; nothing was signed                           | sign a new payment and try again later               |
| `settle_exact_stellar_no_channel_in_time`            | —                | every channel was busy until the deadline                              | sign a new payment and try again later               |
| `settle_exact_stellar_no_channels`                   | —                | every channel is out of the pool                                       | sign a new payment and try again later               |
| `settle_exact_stellar_fee_exceeds_maximum`           | —                | the network fee rose above the facilitator's ceiling                   | sign a new payment and try again later               |
| `settle_exact_stellar_signature_expiration_too_soon` | —                | the auth expires before the pool could land it                         | sign a new payment with a longer `maxTimeoutSeconds` |
| `settle_exact_stellar_simulation_failed`             | —                | the settlement's simulation failed, e.g. the payer's balance           | check the payer, then sign a new payment             |
| `settle_exact_stellar_unexpected_balance_changes`    | —                | the transaction moves something other than the one payment             | refuse: the payment is malformed                     |
| `settle_exact_stellar_record_write_failed`           | —                | the hash couldn't be stored, so nothing was sent                       | sign a new payment                                   |
| `settle_exact_stellar_refused`, or a spend reason    | —                | the facilitator's spend limits refused it                              | don't retry soon                                     |
| `settle_exact_stellar_transaction_failed`            | the hash         | included in a ledger, but failed                                       | sign a new payment                                   |
| `settle_exact_stellar_transaction_submission_failed` | the hash         | refused by the network before inclusion                                | sign a new payment                                   |
| `settle_exact_stellar_transaction_expired`           | the hash         | not included before its time or ledger bound                           | sign a new payment                                   |
| `invalid_exact_stellar_*`, `invalid_network`         | —                | the `/verify` checks, rerun by `/settle`, refused the payment          | fix the payment                                      |
| `unexpected_settle_error`                            | —                | an error of ours after the claim                                       | sign a new payment, and tell us                      |

A failure with no `transaction` sent nothing. The same payment gets the same answer again, so a
retry needs a new payment (a new nonce); only `settlement_pending` is worth repeating as is.
