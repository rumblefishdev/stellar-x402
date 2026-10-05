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
  /** Rejected before inclusion (e.g. `sendTransaction` returned `ERROR`). */
  | "rejected"
  /** Never included before its time bound passed; the sequence number was not consumed. */
  | "expired";

export interface SubmitResult {
  status: SubmitStatus;
  /** Hash of the submitted envelope (the fee bump's hash). */
  hash?: string;
  /** Channel account that provided the sequence number. */
  channel: string;
  ledger?: number;
  feeCharged?: bigint;
  /** Result code name for `failed` and `rejected`, e.g. `txFeeBumpInnerFailed`. */
  errorCode?: string;
}
