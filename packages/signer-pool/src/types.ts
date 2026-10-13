import type { rpc } from "@stellar/stellar-sdk";

/**
 * The RPC calls the pool needs. `rpc.Server` satisfies it; tests pass a fake.
 */
export type SorobanRpc = Pick<
  rpc.Server,
  | "getAccount"
  | "getAccountEntry"
  | "simulateTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getLatestLedger"
  | "getFeeStats"
>;

/**
 * Signs whole transactions as the facilitator (SEP-43 `signTransaction` shape, the same as
 * `@x402/stellar`'s `FacilitatorStellarSigner`). The key may live in memory, a KMS or an HSM.
 */
export interface TransactionSigner {
  readonly address: string;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
}

/** Final outcome of one submission. */
export type SubmitStatus =
  /** Applied successfully. */
  | "success"
  /** Included in a ledger but failed; the sequence number was consumed. */
  | "failed"
  /**
   * Rejected before inclusion (e.g. `sendTransaction` returned `ERROR` with `txBadSeq` or
   * `txInsufficientFee`; `txTooLate` is `expired`). Nothing was applied, so the payment is safe to
   * submit again.
   */
  | "rejected"
  /**
   * Never included before its time bound or ledger bound (`maxLedger`) passed, including a send
   * the network refused with `txTooLate` and a bound that passed while `onSigned` ran. Nothing was
   * applied; the sequence number was not consumed.
   */
  | "expired"
  /**
   * No final answer by the time bound plus `confirmGraceSeconds` (the RPC did not answer): the
   * transaction may still land. The channel stays out of the pool until it is final, and a
   * `resolved` event reports the outcome.
   */
  | "pending";

/**
 * One signed envelope of a submission: each one given to `onSigned`, or sent. A `txBadSeq`
 * rebuild adds a second. Prepared-ahead envelopes that were dropped unsent are not attempts.
 */
export interface Attempt {
  hash: string;
  /**
   * - `yes`: the network answered a send (accepted it, or refused it with an error);
   * - `no`: never sent, or only answered `TRY_AGAIN_LATER` (not taken);
   * - `unknown`: a send threw and nothing answered since, so the network may have taken it.
   */
  sent: "yes" | "no" | "unknown";
}

export interface SubmitResult {
  status: SubmitStatus;
  /** Hash of the submitted envelope (the fee bump's hash). */
  hash?: string;
  /** Channel account that provided the sequence number. */
  channel: string;
  ledger?: number;
  feeCharged?: bigint;
  /**
   * Result code name for `failed` and `rejected`, e.g. `txFeeBumpInnerFailed`, and `txTooLate`
   * for an `expired` send the network refused.
   */
  errorCode?: string;
  /** Every attempt of this submission, in order; the last one is `hash`. */
  attempts: Attempt[];
}
