import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Lifecycle of a settlement record (AD-16). States only move forward:
 * `claimed → signed → pending → success | failed | rejected | expired`.
 * A record can skip a state, e.g. `signed → success`. One written exception (0073 decision 5):
 * {@link SettlementStore.reopen} moves a `rejected` record that never had a hash back to `claimed`.
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
  /** When a `/settle` call first answered this record's `success` (AD-6: once per record). */
  successAnsweredAt?: number;
  /**
   * Starts at 0 and goes up by one with every hash `addHash` appends and with every reopen, so a
   * write that passes the version it read fails once a hash was stored, or the record reopened,
   * after that read (0019 decision 26, 0073 decision 19).
   */
  version: number;
  /**
   * How many times {@link SettlementStore.reopen} moved the record back to `claimed` (0073
   * decision 14); 0 for a record claimed once. -1 for a record claimed before 0073, which never
   * reopens: its release answered "sign a new payment" (0073 decision 25).
   */
  reopened: number;
  /** Milliseconds since the epoch; a reopen sets it to the reopening call's start. */
  createdAt: number;
  updatedAt: number;
}

export type NewSettlement = Omit<
  SettlementRecord,
  | "state"
  | "hashes"
  | "channel"
  | "ledger"
  | "feeCharged"
  | "errorReason"
  | "successAnsweredAt"
  | "version"
  | "reopened"
  | "updatedAt"
>;

export type ClaimResult =
  | { claimed: true; record: SettlementRecord }
  /** The key already exists; the caller compares fingerprints (AD-6). */
  | { claimed: false; existing: SettlementRecord };

/** Fields a state change may set. */
export type SettlementUpdate = Partial<
  Pick<SettlementRecord, "channel" | "ledger" | "feeCharged" | "errorReason">
> & {
  state: SettlementState;
  updatedAt: number;
  /** Attempt states written in the same transaction, whether or not the state moves. */
  attempts?: AttemptUpdate[];
};

/**
 * Lifecycle of one signed transaction of a settlement (0019 decision 7). States only move forward:
 * `stored → sent | unknown → landed | dead`. `stored` and `sent`/`unknown` are hints that can lag
 * the network (a crash, a write that failed); `landed` and `dead` are the network's answers.
 */
export type AttemptState = "stored" | "sent" | "unknown" | "landed" | "dead";

/** The bounds of a signed transaction: past either one it can no longer land. */
export interface AttemptBounds {
  /** The time bound, in Unix seconds; unset for an envelope bounded by `maxLedger` alone (0073). */
  maxTime?: number;
  /** The last ledger it may land in (inclusive). */
  maxLedger?: number;
}

/** One signed transaction of a settlement: a row of its hashes. */
export interface SettlementAttempt extends Partial<AttemptBounds> {
  hash: string;
  /** `stored` too for a hash written before the attempt states existed. */
  state: AttemptState;
  /** Channel account whose sequence number it used. */
  channel?: string;
  /** Why it died, e.g. `txBadSeq`. */
  errorCode?: string;
  /** Milliseconds since the epoch; absent until it is first written with a state. */
  updatedAt?: number;
}

/** A state an attempt moves to, with what is known about it. */
export interface AttemptUpdate {
  hash: string;
  state: AttemptState;
  channel?: string;
  errorCode?: string;
}

/** `addHash` was given a hash another settlement already has; neither record changed. */
export class HashConflictError extends Error {
  override readonly name = "HashConflictError";
  constructor(readonly hash: string) {
    super("transaction hash already belongs to another settlement");
  }
}

/**
 * `addHash` was given a lease token that is no longer the lease's current one (0071): another
 * process took the lease since this one acquired it, or nobody holds it. Nothing changed, and
 * the hash must not be sent.
 */
export class LeaseFencedError extends Error {
  override readonly name = "LeaseFencedError";
  constructor(readonly lease: string) {
    super(`the lease ${lease} has a newer holder or none, so this process may not send`);
  }
}

/**
 * How long past a lease's `expiresAt` another holder must wait to take it (0025 decision 16).
 * `expiresAt` comes from the holder's clock and is compared with the acquirer's, so a holder whose
 * clock lags by less than this still renews before anyone takes over. One value for every process
 * on a store, so it is not a setting.
 */
export const LEASE_SKEW_MARGIN_MS = 5_000;

/** An exclusive, renewable lease on one network's channel set (AD-17). */
export interface ChannelLease {
  /** What is leased, e.g. `stellar:testnet:channels`. */
  name: string;
  /** Unique per process. */
  holder: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** New on every acquire, kept by a renewal (0071 decisions 1, 2). */
  token: string;
}

/** The lease a call claims to send under: its name and the token of the acquire that took it. */
export type LeaseFence = Pick<ChannelLease, "name" | "token">;

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
   * Appends a signed hash, durably, before it is first sent, moves `claimed` to `signed` and adds
   * one to the record's `version`.
   * In order of precedence:
   * 0. a `lease` whose token is no longer the lease's current one, or a lease nobody holds,
   *    rejects with `LeaseFencedError`, and nothing changes (0071). The lease row is locked in
   *    the same statement, so a takeover either waits for the hash to be stored or is seen;
   * 1. a missing or final record, or with `claim` one reopened since that claim (its `reopened`
   *    differs, 0073 decision 19), resolves `false`;
   * 2. a hash already on this record resolves `true`, a no-op;
   * 3. a hash on another record rejects with `HashConflictError`, and neither record changes;
   * 4. otherwise the hash is appended and it resolves `true`.
   * Atomic with {@link transition}: against a concurrent `transition(key, "claimed", …)` to a
   * final state, exactly one wins. A check-then-write would let `/settle` answer `…_timeout` for a
   * hash that is then sent. An appended hash is a `stored` attempt with `bounds`, which
   * reconciliation needs to tell when a hash the network doesn't know can no longer land.
   */
  addHash(
    key: SettlementKey,
    hash: string,
    lease: LeaseFence,
    updatedAt: number,
    bounds?: AttemptBounds,
    claim?: number,
  ): Promise<boolean>;
  /** The record's attempts, oldest first, in the order of `hashes`. */
  attempts(key: SettlementKey): Promise<SettlementAttempt[]>;
  /**
   * Moves the record's attempts forward, each on its own: an update that isn't ahead of the
   * attempt's state, or names a hash of another record, is dropped. Resolves how many moved.
   */
  markAttempts(key: SettlementKey, updates: AttemptUpdate[], updatedAt: number): Promise<number>;
  /**
   * Compare-and-set on `successAnsweredAt`: sets it while the record is `success` and has none.
   * Resolves `true` for exactly one of several concurrent callers, the one whose answer may be
   * `success` (AD-6). It leaves `updatedAt` as it is: the mark records an answer, not a step of
   * the lifecycle.
   */
  markSuccessAnswered(key: SettlementKey, at: number): Promise<boolean>;
  /**
   * Compare-and-set: applies `update` only while the record is in state `expected`. Resolves
   * the updated record, or `undefined` if the state had already moved on. An `update.state`
   * that isn't ahead of `expected` in the lifecycle order, the same state included, is dropped
   * the same way, so exactly one of several concurrent callers wins. A record in a final state
   * never moves on (AD-16). Rejects a `feeCharged` that isn't a non-negative int64.
   * `update.attempts` are applied as {@link markAttempts} would, in the same transaction, also
   * when the state doesn't move. With `expectedVersion`, the record must also still have that
   * `version`: no hash was appended since the caller read it. With `claim`, it must still have
   * that `reopened` count: a write of an earlier claim never lands on a reopened one (0073
   * decision 24).
   */
  transition(
    key: SettlementKey,
    expected: SettlementState,
    update: SettlementUpdate,
    expectedVersion?: number,
    claim?: number,
  ): Promise<SettlementRecord | undefined>;
  /**
   * Compare-and-set, the one backward move (0073 decision 5): moves the record from `rejected`
   * back to `claimed` while it has the same `fingerprint`, one of `reasons` as its `errorReason`,
   * no hash, so nothing was ever sent for it, and was claimed since 0073 (`reopened` not -1). Clears `errorReason`, adds one to `reopened` and
   * to `version`, and sets `createdAt` and `updatedAt` to `now`, so a repeat counts the new
   * claim's budget from it, and a writer that read the earlier claim and passes its version or
   * `reopened` count fails (0073 decision 19).
   * Resolves the reopened record, or `undefined` if any condition fails: exactly one of several
   * concurrent callers wins.
   */
  reopen(
    key: SettlementKey,
    fingerprint: string,
    reasons: readonly string[],
    now: number,
  ): Promise<SettlementRecord | undefined>;
  /** Records not yet final, for the startup re-check (AD-16). */
  listNonFinal(network: StellarNetwork): Promise<SettlementRecord[]>;

  /**
   * Takes the lease if it is free, already held by `holder`, or another holder's that expired more
   * than {@link LEASE_SKEW_MARGIN_MS} before `now`, and sets its expiry to `now + ttlMs`. Every
   * acquire gives the lease a new `token`, also one by its own holder (0071 decision 1), so a call
   * that carries an earlier token is refused by `addHash`. Resolves the lease, or `undefined` if
   * another holder has it.
   */
  acquireLease(
    name: string,
    holder: string,
    ttlMs: number,
    now: number,
  ): Promise<ChannelLease | undefined>;
  /**
   * Extends a lease `holder` still holds, keeping its token. Resolves `false` if it was lost,
   * including once `now > expiresAt`: an expired lease must be acquired again.
   */
  renewLease(name: string, holder: string, ttlMs: number, now: number): Promise<boolean>;
  /** Releases the lease if `holder` holds it. */
  releaseLease(name: string, holder: string): Promise<void>;
}
