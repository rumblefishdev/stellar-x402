import type { FailureCause, SubmitResult } from "@stellar-x402/signer-pool";
import { NONCE_CONSUMED_SETTLE_REASON, consumedElsewhere, type IsNonceUsed } from "./nonce-used.js";
import { PAYER_AUTH_REASON, UNSUPPORTED_CREDENTIAL_REASON } from "./verify.js";

/**
 * Every `errorReason` `/settle` sends besides the reasons of the `/verify` checks (AD-6). Three are
 * upstream's own settle codes for the same outcome (`failed`, `rejected`, `unexpected`), and
 * `pending` is `@x402/core`'s. `payerAuth` and `unsupportedCredential` are `/verify` reasons too:
 * `/settle` sends them from its own re-check, and the pool's guard gives the second.
 */
export const SETTLE_REASONS = {
  /** Sent, not final by its bound (the RPC stopped answering) or the settle budget. */
  pending: "settlement_pending",
  /** Included in a ledger but failed (upstream's code). */
  failed: "settle_exact_stellar_transaction_failed",
  /** Refused by the network before inclusion, e.g. `txBadSeq` twice (upstream's code). */
  rejected: "settle_exact_stellar_transaction_submission_failed",
  /** Not included before its ledger bound, the payer's auth expiry: it can no longer land. */
  expired: "settle_exact_stellar_transaction_expired",
  /** The settlement's own simulation failed. */
  simulation: "settle_exact_stellar_simulation_failed",
  /** The settlement's simulation moves something other than the one expected transfer. */
  balanceChanges: "settle_exact_stellar_unexpected_balance_changes",
  /**
   * The settlement's simulation never used the payer's auth entry: the token's `transfer` doesn't
   * require the payer's signature, so the event's `from` proves nothing.
   */
  payerNotAuthorized: "settle_exact_stellar_payer_not_authorized",
  /** The settlement's simulated fee is above `MAX_FEE_STROOPS`. */
  fee: "settle_exact_stellar_fee_exceeds_maximum",
  /** Fewer than two ledgers were left before the auth expiry by the time a channel was free. */
  ledgerBound: "settle_exact_stellar_signature_expiration_too_soon",
  /** The signed hash could not be stored, so nothing was sent. */
  recordWrite: "settle_exact_stellar_record_write_failed",
  /**
   * The facilitator key's signer (OpenBao, 0036) failed on the transaction (upstream's code).
   * This envelope wasn't sent ({@link UNSENT_REASONS}).
   */
  transactionSigning: "settle_exact_stellar_transaction_signing_failed",
  /** The signer failed on the fee bump (upstream's code). This envelope wasn't sent ({@link UNSENT_REASONS}). */
  feeBumpSigning: "settle_exact_stellar_fee_bump_signing_failed",
  /** No channel was free before the deadline. Nothing was sent ({@link UNSENT_REASONS}). */
  noChannelInTime: "settle_exact_stellar_no_channel_in_time",
  /** Every channel is out of the pool. Nothing was sent ({@link UNSENT_REASONS}). */
  noChannels: "settle_exact_stellar_no_channels",
  /** The before-submit hook threw. A refusal carries the hook's own reason. */
  refused: "settle_exact_stellar_refused",
  /** The payload doesn't carry exactly one auth entry for the payer, so it has no settlement key. */
  payerAuth: PAYER_AUTH_REASON,
  /**
   * This payer's nonce was already used for a different payload or requirements. `transaction`
   * is the stored hash, if any, never the outcome.
   */
  nonceUsed: "settle_exact_stellar_nonce_already_used",
  /**
   * Another transaction used the payer's nonce first (0141): our transaction failed on chain, or
   * the pool's simulation did, so the payment may have settled there. Never answered `success`:
   * one signed entry raced through two facilitators would then be served twice.
   */
  nonceConsumedElsewhere: NONCE_CONSUMED_SETTLE_REASON,
  /**
   * This payment settled, and its `success` was already answered once (AD-6). `transaction` is
   * its hash. The resource was paid for once, so it is served once.
   */
  alreadySettled: "settle_exact_stellar_already_settled",
  /**
   * The settle budget ran out before anything was signed: nothing was or will be sent for this
   * payment ({@link UNSENT_REASONS}).
   */
  timeout: "settle_exact_stellar_timeout",
  /**
   * No RPC endpoint answered before anything was signed (every one refused, failed or timed
   * out). Not a bug: try again later ({@link UNSENT_REASONS}).
   */
  rpcUnavailable: "settle_exact_stellar_rpc_unavailable",
  /** An auth entry with source-account credentials would authorize as the channel (AD-5). */
  unsupportedCredential: UNSUPPORTED_CREDENTIAL_REASON,
  /**
   * The facilitator stopped before anything was signed (a crash or a restart), and reconciliation
   * closed the record: nothing was or will be sent for this payment ({@link UNSENT_REASONS}).
   */
  interrupted: "settle_exact_stellar_interrupted",
  /**
   * The facilitator was stopping (a deploy) before anything was signed: nothing was or will be
   * sent for this payment ({@link UNSENT_REASONS}); a retry reaches the next process (0025).
   */
  shuttingDown: "settle_exact_stellar_shutting_down",
  /**
   * This process lost the channel lease before it sent this envelope: another process took it,
   * or none holds it (0071). Nothing is on its way for this payment ({@link UNSENT_REASONS}); a
   * retry reaches the process that holds it. With a `transaction` the record has that hash, so it
   * doesn't reopen: an envelope never sent, or one a `txBadSeq` refused before the rebuild.
   */
  leaseLost: "settle_exact_stellar_lease_lost",
  /**
   * Another payment from this payer in this asset was still settling when the settle budget ran
   * out (0024): one balance is spent by one settlement at a time. Nothing was claimed, signed or
   * sent for this payment: send the same payment again.
   */
  payerBusy: "settle_exact_stellar_payer_busy",
  /**
   * The payer's fee budget for this window is spent (AD-18): for a known asset its budget, for
   * another token its budget in that token. Nothing was sent; the buyer waits for the window.
   */
  spendLimitPayer: "settle_exact_stellar_spend_limit_payer",
  /** The recipient's fee budget for this window is spent. The seller asks the operator. */
  spendLimitPayTo: "settle_exact_stellar_spend_limit_pay_to",
  /** The asset's fee budget for this window is spent. Pay in another asset. */
  spendLimitAsset: "settle_exact_stellar_spend_limit_asset",
  /** The budget all tokens but the known ones share is spent. Pay in a known asset. */
  spendLimitOther: "settle_exact_stellar_spend_limit_other",
  /** The facilitator's fee budget for this window is spent. Use another facilitator. */
  spendLimitGlobal: "settle_exact_stellar_spend_limit_global",
  /** The payer's settlements failed on chain too often: its breaker is open for a while. */
  breakerOpenPayer: "settle_exact_stellar_breaker_open_payer",
  /** Settlements to this recipient failed on chain too often: its breaker is open for a while. */
  breakerOpenPayTo: "settle_exact_stellar_breaker_open_pay_to",
  /** This wasm token's transfers failed on chain too often: its breaker is open for a while. */
  breakerOpenAsset: "settle_exact_stellar_breaker_open_asset",
  /**
   * The spend store didn't answer within the settle budget, so no fee could be reserved and
   * nothing was sent (fail closed). Sign a new payment shortly.
   */
  spendStoreUnavailable: "settle_exact_stellar_spend_store_unavailable",
  /** The facilitator's fee account is below its floor. Nothing was sent; the operator acts. */
  facilitatorUnderfunded: "settle_exact_stellar_facilitator_underfunded",
  /** Anything else (upstream's code). */
  unexpected: "unexpected_settle_error",
} as const;

/**
 * Reasons a record ends with when nothing was sent for it (0073 decisions 3, 5, 15). The payer's
 * auth entry can still land until its expiration ledger, by whoever holds the payload, so the
 * answer never says "sign a new payment" while it is valid: it carries `extra.retryable` and
 * `extra.expirationLedger`, and the identical payload reopens the record and settles it once.
 * Past that ledger, `retryable` is `false`: sign a new payment. With a `transaction` an earlier
 * envelope was sent and a `txBadSeq` refused it before the rebuild: the record has its hash, so it
 * doesn't reopen and `retryable` is `false` at once.
 */
export const UNSENT_REASONS: readonly string[] = [
  SETTLE_REASONS.timeout,
  SETTLE_REASONS.rpcUnavailable,
  SETTLE_REASONS.interrupted,
  SETTLE_REASONS.shuttingDown,
  SETTLE_REASONS.noChannelInTime,
  SETTLE_REASONS.noChannels,
  SETTLE_REASONS.leaseLost,
  SETTLE_REASONS.transactionSigning,
  SETTLE_REASONS.feeBumpSigning,
  // Transient spend-lane refusals (0024): the floor was momentarily below, or the store timed
  // out. Nothing was sent and the payment is still valid, so the identical payload reopens and
  // settles once the floor or store recovers, as the infra failures above do. The budget and
  // breaker refusals are not here: those are a deliberate wait or cut-off, not a transient miss.
  SETTLE_REASONS.facilitatorUnderfunded,
  SETTLE_REASONS.spendStoreUnavailable,
];
export const UNSENT = new Set(UNSENT_REASONS);

/**
 * Failed answers about a record that don't tell the payer to sign again (0082): it isn't over, it
 * landed, the payload is another payment, its auth entry has expired, or nothing was recorded
 * because another payment of the payer and asset held the slot (0024). Every other failed answer
 * about a record ended a payment whose auth entry can still land until its expiration ledger, in
 * a new envelope: our failed or refused transaction spent no nonce. A nonce another transaction
 * used gets no advice at all (0141, `withRetry`).
 */
export const NOT_SIGN_AGAIN = new Set<string>([
  SETTLE_REASONS.pending,
  SETTLE_REASONS.alreadySettled,
  SETTLE_REASONS.nonceUsed,
  SETTLE_REASONS.expired,
  SETTLE_REASONS.payerBusy,
]);

/**
 * The `errorReason` of a pool result that isn't a success: its fixed one, or 0141's when another
 * transaction used the payer's nonce first. An RPC without diagnostic events gives no error to
 * read, so then the payer's nonce entry tells: ours failed and wrote no nonce, so an entry means
 * another transaction used it. Every writer that ends a record calls this (0141 decision 6).
 */
export async function resultReason(
  status: Exclude<SubmitResult["status"], "success">,
  failure: FailureCause | undefined,
  payer: string,
  nonce: string,
  nonceUsed: IsNonceUsed,
): Promise<string> {
  if (status !== "failed") return SETTLE_REASONS[status];
  if (consumedElsewhere(failure, payer)) return SETTLE_REASONS.nonceConsumedElsewhere;
  if (await nonceUsed(payer, nonce)) return SETTLE_REASONS.nonceConsumedElsewhere;
  return SETTLE_REASONS.failed;
}
