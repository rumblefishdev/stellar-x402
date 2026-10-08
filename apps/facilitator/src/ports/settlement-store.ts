import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Lifecycle of a settlement record (AD-16). States only move forward:
 * `claimed → signed → pending → success | failed | rejected | expired`.
 * A record can skip a state, e.g. `signed → success`.
 */
export type SettlementState =
  "claimed" | "signed" | "pending" | "success" | "failed" | "rejected" | "expired";

export const FINAL_SETTLEMENT_STATES: readonly SettlementState[] = [
  "success",
  "failed",
  "rejected",
  "expired",
];

/** `network:payer:nonce`; the nonce is the payer auth entry's int64 nonce as a decimal string (AD-6). */
export type SettlementKey = `${StellarNetwork}:${string}:${string}`;

export interface SettlementRecord {
  key: SettlementKey;
  network: StellarNetwork;
  payer: string;
  nonce: string;
  /** Hash of the canonical payload plus `paymentRequirements` (AD-6). */
  fingerprint: string;
  state: SettlementState;
  /** Every hash the transaction was signed with, oldest first; a rebuild adds one (AD-16). */
  hashes: string[];
  /** Kept so a late `success` can still catalog the resource (AD-8). */
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  channel?: string;
  ledger?: number;
  /** Fee actually paid, in stroops. */
  feeCharged?: bigint;
  /** x402 `errorReason` for a final state other than `success`. */
  errorReason?: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  updatedAt: number;
}

export type NewSettlement = Omit<
  SettlementRecord,
  "state" | "hashes" | "channel" | "ledger" | "feeCharged" | "errorReason" | "updatedAt"
>;

export type ClaimResult =
  | { claimed: true; record: SettlementRecord }
  /** The key already exists; the caller compares fingerprints (AD-6). */
  | { claimed: false; existing: SettlementRecord };

/** Fields a state change may set. */
export type SettlementUpdate = Partial<
  Pick<SettlementRecord, "channel" | "ledger" | "feeCharged" | "errorReason">
> & { state: SettlementState; updatedAt: number };

/** An exclusive, renewable lease on one network's channel set (AD-17). */
export interface ChannelLease {
  /** What is leased, e.g. `stellar:testnet:channels`. */
  name: string;
  /** Unique per process. */
  holder: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/**
 * Settlement records and the channel lease (AD-6, AD-7, AD-16, AD-17). Only the settlement
 * module writes to it.
 */
export interface SettlementStore {
  /** Atomic insert-if-absent: exactly one of several concurrent claims for a key wins. */
  claim(settlement: NewSettlement): Promise<ClaimResult>;
  get(key: SettlementKey): Promise<SettlementRecord | undefined>;
  /** Finds a record by any of its hashes. */
  findByHash(hash: string): Promise<SettlementRecord | undefined>;
  /**
   * Appends a signed hash, durably, before it is first sent. Moves `claimed` to `signed`; a
   * hash that is already there is a no-op. Resolves `false` if the record is final or missing.
   */
  addHash(key: SettlementKey, hash: string, updatedAt: number): Promise<boolean>;
  /**
   * Compare-and-set: applies `update` only while the record is in state `expected`. Resolves
   * the updated record, or `undefined` if the state had already moved on. An `update.state`
   * behind `expected` in the lifecycle order is dropped the same way (AD-16).
   */
  transition(
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
  ): Promise<SettlementRecord | undefined>;
  /** Records not yet final, for the startup re-check (AD-16). */
  listNonFinal(network: StellarNetwork): Promise<SettlementRecord[]>;

  /**
   * Takes the lease if it is free, expired or already held by `holder`, and sets its expiry to
   * `now + ttlMs`. Resolves the lease, or `undefined` if another holder has it.
   */
  acquireLease(
    name: string,
    holder: string,
    ttlMs: number,
    now: number,
  ): Promise<ChannelLease | undefined>;
  /**
   * Extends a lease `holder` still holds. Resolves `false` if it was lost, including once
   * `now > expiresAt`: an expired lease must be acquired again.
   */
  renewLease(name: string, holder: string, ttlMs: number, now: number): Promise<boolean>;
  /** Releases the lease if `holder` holds it. */
  releaseLease(name: string, holder: string): Promise<void>;
}
