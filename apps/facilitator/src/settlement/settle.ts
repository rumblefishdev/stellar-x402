import { createHash } from "node:crypto";
import {
  Address,
  Transaction,
  scValToNative,
  xdr,
  type Operation,
  type rpc,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@stellar-x402/config";
import {
  FeeLimitError,
  LedgerBoundError,
  NoChannelsError,
  QueueTimeoutError,
  RpcTimeoutError,
  RpcUnavailableError,
  ShutdownError,
  SignedHookError,
  SimulationCheckError,
  SimulationError,
  SourceAccountAuthError,
  attemptsOf,
  type ContractCall,
  type SubmitOptions,
  type SubmitResult,
} from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getNetworkPassphrase } from "@x402/stellar";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { SettlementKey, SettlementRecord, SettlementStore } from "../ports/index.js";
import type { BeforeSubmitResult, SettlementHooks, SettlementOrigin } from "./hooks.js";
import {
  attemptUpdates,
  createRecords,
  isFinalRecord as isFinal,
  type Records,
} from "./records.js";
import {
  PAYER_AUTH_REASON,
  UNSUPPORTED_CREDENTIAL_REASON,
  authExpiration,
  payerNonce,
  type Check,
  type Verified,
} from "./verify.js";

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
  /** The settlement's simulated fee is above `MAX_FEE_STROOPS`. */
  fee: "settle_exact_stellar_fee_exceeds_maximum",
  /** Fewer than two ledgers were left before the auth expiry by the time a channel was free. */
  ledgerBound: "settle_exact_stellar_signature_expiration_too_soon",
  /** The signed hash could not be stored, so nothing was sent. */
  recordWrite: "settle_exact_stellar_record_write_failed",
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
  /** An auth entry with source-account credentials would authorize as the facilitator (AD-5). */
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
  /** Anything else (upstream's code). */
  unexpected: "unexpected_settle_error",
} as const;

/**
 * Reasons a record ends with when nothing was sent for it (0073 decisions 3, 5, 15). The payer's
 * auth entry can still land until its expiration ledger, by whoever holds the payload, so the
 * answer never says "sign a new payment" while it is valid: it carries `extra.retryable` and
 * `extra.expirationLedger`, and the identical payload reopens the record and settles it once.
 * Past that ledger, `retryable` is `false`: sign a new payment.
 */
export const UNSENT_REASONS: readonly string[] = [
  SETTLE_REASONS.timeout,
  SETTLE_REASONS.rpcUnavailable,
  SETTLE_REASONS.interrupted,
  SETTLE_REASONS.shuttingDown,
  SETTLE_REASONS.noChannelInTime,
  SETTLE_REASONS.noChannels,
];
const UNSENT = new Set(UNSENT_REASONS);

/**
 * The validity minimum `/settle` rechecks with (AD-22): the pool's own floor. `signer-pool` keeps
 * one spare ledger and refuses a call that has fewer than 2 ledgers left, so `/settle` refuses
 * only what the pool would. `/verify`'s larger `MIN_VALIDITY_LEDGERS` leaves room for the time
 * between `/verify` and `/settle`; rechecking with it would refuse payments the pool still signs.
 */
export const SETTLE_MIN_VALIDITY_LEDGERS = 2;

/**
 * Refusals that mean `/settle` disagreed with a `/verify` that accepted: the fee rose above the
 * ceiling (a new fee-stats reading or escalation, caught by the pool or by `/settle`'s own
 * re-check), or the auth expiry came too close while the call waited for a channel.
 */
const REFUSED_AFTER_VERIFY = new Set<string>([
  SETTLE_REASONS.fee,
  SETTLE_REASONS.ledgerBound,
  // Upstream's code, from `/settle`'s re-check of the checks.
  "invalid_exact_stellar_payload_fee_exceeds_maximum",
]);

/** The pool as `/settle` uses it. */
export interface Submitter {
  submit(call: ContractCall, opts?: SubmitOptions): Promise<SubmitResult>;
}

export interface SettlerDeps {
  network: StellarNetwork;
  /** The `/verify` checks (AD-3). */
  check: Check;
  store: SettlementStore;
  submitter: Submitter;
  hooks: Pick<SettlementHooks, "beforeSubmit" | "onFinal" | "onSuccess">;
  logger: Logger;
  metrics: Metrics;
  /** Passed to `beforeSubmit` as the most the facilitator can pay for this settlement. */
  maxFeeStroops: bigint;
  /** How long a repeat call waits for a signed record to turn final (AD-6). */
  settleTimeoutMs: number;
  /** How long one `/settle` call may take, the wait for a channel included (ADR 0011). */
  budgetMs: number;
  /**
   * Whether this process still holds the channel lease (0025). Checked again once a hash is
   * stored, so a call let in before the lease was lost sends nothing on channels another
   * process may own. Always held when unset.
   */
  held?: () => boolean;
  /**
   * The network's latest ledger, to tell whether an unsent payment's auth entry can still land
   * (0073 decision 15). Read only on those answers and before a reopen.
   */
  latestLedger: () => Promise<number>;
  /** Estimated ledger close time, to turn the auth expiry into a deadline. */
  ledgerMs?: number;
  /** The record writes and hooks to share, e.g. with reconciliation; its own by default. */
  records?: Records;
  /** How often a repeat call re-reads a non-final record. */
  pollMs?: number;
  /** How long a store call may take once the budget is out, or while a repeat polls. */
  storeGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Settled {
  response: SettleResponse;
  /** The settlement key, once the payload has one: for the `settled` log. */
  key?: SettlementKey;
  /** Answered from an existing record, not by the call that claimed it. */
  replay?: boolean;
  /** The record behind a `success` answer, for the `EXTENSION-RESPONSES` header (AD-8). */
  record?: SettlementRecord;
  /**
   * Set when this call turned the record `success`: runs `onSuccess(record, "settle")`. The
   * route calls it once the response is sent.
   */
  afterResponse?: () => void;
}

/** `signal` aborts once the client has left: a repeat stops waiting, and no success is used up. */
export type Settle = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  signal?: AbortSignal,
) => Promise<Settled>;

/**
 * `/settle` for `exact` (AD-2, AD-3, AD-6): rerun the `/verify` checks, claim
 * `network:payer:nonce`, run `beforeSubmit`, and submit the client's `{func, auth}` through the
 * pool, bounded by the auth expiry. A repeat call gets the stored outcome, but only with the same
 * fingerprint, and a success is answered once; a repeat of a payment nothing was sent for reopens
 * it while its auth entry is valid (0073). Every record write is a compare-and-set, forward-only
 * but for that reopen, so concurrent callers and a late completion can't both win. Every store and
 * hook call is bounded by the budget. Hooks never change the answer, and their errors are logged.
 */
export function createSettler(deps: SettlerDeps): Settle & {
  /**
   * Waits for every submission under way to end and write its record, including those that run
   * on after the budget answer (0025). Close the pool first, so nothing new is sent meanwhile.
   */
  drain(): Promise<void>;
} {
  const {
    network,
    store,
    logger,
    metrics,
    ledgerMs = 5_000,
    pollMs = 250,
    storeGraceMs = STORE_GRACE_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  /** Every submission under way, with its record write, for `drain()`. */
  const submissions = new Set<Promise<unknown>>();

  const failure = (
    errorReason: string,
    payer: string | undefined,
    errorMessage?: string,
    transaction = "",
  ): SettleResponse => ({ success: false, errorReason, errorMessage, payer, transaction, network });

  const answer = (record: SettlementRecord): SettleResponse => {
    const transaction = record.hashes.at(-1) ?? "";
    if (record.state === "success") {
      return { success: true, transaction, network, payer: record.payer };
    }
    if (isFinal(record)) {
      return failure(
        record.errorReason ?? SETTLE_REASONS.unexpected,
        record.payer,
        undefined,
        transaction,
      );
    }
    // Not final yet: sent or about to be, unless nothing was signed.
    return transaction
      ? failure(SETTLE_REASONS.pending, record.payer, undefined, transaction)
      : failure(SETTLE_REASONS.timeout, record.payer);
  };

  /** The pool's own result, for when the store failed to record it (`submit()`). */
  const answerResult = (result: SubmitResult, payer: string): SettleResponse => {
    const transaction = result.hash ?? "";
    if (result.status === "success") return { success: true, transaction, network, payer };
    return failure(SETTLE_REASONS[result.status], payer, undefined, transaction);
  };

  const records =
    deps.records ?? createRecords({ network, store, hooks: deps.hooks, logger, metrics, now });
  const {
    hookFailed,
    recordFailed,
    onFinal,
    onSuccess,
    advance,
    finalWrite,
    finish,
    answeredHere,
    unmarked,
  } = records;

  /**
   * A refusal that means the pool, or `/settle`'s own re-check, disagreed with a `/verify` that
   * accepted (0009 decision 10). The answer stays; it is logged and counted. `stage` tells them
   * apart: a `check` refusal may come from a payload `/verify` never saw, so anyone can raise it,
   * while a `pool` one comes after the checks passed. Alarms watch `pool`.
   */
  const flagDrift = (
    key: SettlementKey | undefined,
    errorReason: string | undefined,
    stage: "check" | "pool",
  ) => {
    if (errorReason === undefined || !REFUSED_AFTER_VERIFY.has(errorReason)) return;
    logger.warn("settlement_refused_after_verify", {
      network,
      settlementKey: key,
      errorReason,
      stage,
    });
    metrics.increment("settlement_refused_after_verify_total", { reason: errorReason, stage });
  };

  /**
   * How many ledgers the payload's auth entry has left, with its expiration ledger: `left` is
   * unset when the latest ledger couldn't be read in time. `undefined` for a payload whose auth
   * entries can't be read.
   */
  const validity = async (payload: PaymentPayload): Promise<Validity | undefined> => {
    let expiration: number;
    try {
      expiration = authExpiration(
        new Transaction(
          (payload.payload as { transaction: string }).transaction,
          getNetworkPassphrase(network),
        ),
      );
    } catch {
      return undefined;
    }
    try {
      return {
        expiration,
        left: expiration - (await bounded(deps.latestLedger(), LEDGER_READ_MS)),
      };
    } catch (error) {
      logger.warn("latest_ledger_failed", { network, error });
      return { expiration };
    }
  };

  /**
   * An answer that nothing was sent (0073 decisions 15, 17, 18) with `extra.retryable`: `true`
   * while a repeat can still reopen it (the pool needs 2 ledgers left), or when the ledger couldn't
   * be read, since repeating the same payload is always safe. Then `false`, but "sign a new
   * payment" only once the expiration ledger has closed: the auth entry is valid in that ledger,
   * so until then whoever holds the payload may still land it.
   */
  const withRetry = async (
    settled: Settled,
    validOnce: () => Promise<Validity | undefined>,
  ): Promise<Settled> => {
    const { response } = settled;
    if (response.success || response.transaction || !UNSENT.has(response.errorReason ?? ""))
      return settled;
    const valid = await validOnce();
    if (!valid) return settled;
    const { expiration, left } = valid;
    const retryable = left === undefined || left >= SETTLE_MIN_VALIDITY_LEDGERS;
    const then = `once the network is past ledger ${expiration}, sign a new payment instead`;
    const errorMessage =
      left === undefined
        ? `nothing was sent: repeat the same payment; ${then}`
        : retryable
          ? `nothing was sent: repeat the same payment while the latest ledger is at most ` +
            `${expiration - SETTLE_MIN_VALIDITY_LEDGERS}; ${then}`
          : left > 0
            ? `nothing was sent, and it is too late to settle here, but the auth entry may still ` +
              `land in ledger ${expiration}: once that ledger has closed, sign a new payment`
            : `nothing was sent, and the auth entry expired with ledger ${expiration}: sign a new ` +
              `payment`;
    return {
      ...settled,
      response: {
        ...response,
        errorMessage,
        extra: { ...response.extra, retryable, expirationLedger: expiration },
      },
    };
  };

  /**
   * Ends a record nothing was signed for: `claimed → rejected` with `…_timeout`, by
   * compare-and-set (ADR 0011, 0009 decision 11). `addHash` then refuses it, so nothing is signed
   * and sent after the answer; `onFinal` runs for the writer that ended it, once `after` (a
   * `beforeSubmit` still running) has settled, so a late reservation is released too. A record
   * with a hash stays open, and so does a claim made after `version` was read: a reopen changes
   * it (0073 decision 19). Never throws: the record as stored, or `undefined` if the store didn't
   * answer within `storeGraceMs`, when nothing is known about it.
   */
  const endUnsigned = async (key: SettlementKey, version: number, after?: Promise<unknown>) => {
    try {
      return await bounded(
        (async () => {
          const ended = await finalWrite(key, () =>
            store.transition(
              key,
              "claimed",
              { state: "rejected", errorReason: SETTLE_REASONS.timeout, updatedAt: now() },
              version,
            ),
          );
          if (ended && after) {
            const run = () => onFinal(ended, "settle");
            after.then(run, run);
          } else if (ended) onFinal(ended, "settle");
          return ended ?? (await store.get(key));
        })(),
        storeGraceMs,
      );
    } catch (error) {
      recordFailed(key, error);
      return undefined;
    }
  };

  /**
   * The answer for `record`. A `success` is answered once (AD-6): the caller that marks it gets
   * `success: true` and the record, for the `EXTENSION-RESPONSES` header; every later one gets
   * `…_already_settled` with the hash, so one payment unlocks one response. A caller whose client
   * already left marks nothing, so the client's retry still gets the success. When the store
   * can't mark, the payment still landed, so the caller gets the success (ADR 0006): after the
   * store recovers, or on another instance, a repeat may get a second one until 0019.
   * Whoever marks first gets the success, not necessarily the call that submitted: on PostgreSQL a
   * repeat's poll can read `success` between the submitter's `transition` and its mark. Still one
   * success and one `onSuccess`.
   */
  /** A success answered before, by this process or another (AD-6), with the hash that landed. */
  const alreadySettled = (payer: string, hash: string) => {
    metrics.increment("settlement_already_settled_total");
    return failure(
      SETTLE_REASONS.alreadySettled,
      payer,
      "this payment's success was already answered",
      hash,
    );
  };

  const respond = async (
    record: SettlementRecord,
    signal: AbortSignal | undefined,
    extra: Pick<Settled, "afterResponse" | "replay"> = {},
  ): Promise<Settled> => {
    const settled = { key: record.key, ...extra };
    if (record.state !== "success") return { ...settled, response: answer(record) };
    if (signal?.aborted) return { ...settled, response: answer(record) };
    // Answered already: a mark that fails now must not answer it again (0019 decision 33).
    if (record.successAnsweredAt !== undefined)
      return { ...settled, response: alreadySettled(record.payer, record.hashes.at(-1) ?? "") };
    const answeredAt = now();
    let first = !answeredHere.has(record.key);
    if (first) {
      answeredHere.add(record.key);
      try {
        first = await bounded(store.markSuccessAnswered(record.key, answeredAt), storeGraceMs);
        answeredHere.delete(record.key);
      } catch (error) {
        // The payment landed; a store that can't say whether it was answered gets the success.
        // The key stays here, so this process doesn't answer it again, until reconciliation marks
        // it once the store is back (0019 decision 9).
        recordFailed(record.key, error);
        unmarked.add(record.key);
        first = true;
      }
    }
    if (!first)
      return { ...settled, response: alreadySettled(record.payer, record.hashes.at(-1) ?? "") };
    return {
      ...settled,
      response: answer(record),
      record: { ...record, successAnsweredAt: answeredAt },
    };
  };

  /** One `/settle` call's own state, shared with its submission. */
  interface Call {
    /** Set when the budget answer goes out: `onSigned` refuses every new hash from then on. */
    budgetOver: boolean;
    /** The hash `onSigned` was last given, stored or not. */
    signing?: string;
    /** Where a record this call finishes turns final: `resolved` once the budget answer is out. */
    origin: SettlementOrigin;
  }

  /**
   * Submits a claimed settlement and records the result. Never rejects. When the store fails
   * after the pool answered, `fallback` is the answer from the pool's result: it says what
   * happened on chain.
   */
  const submit = async (
    claimed: SettlementRecord,
    verified: Verified,
    requirements: PaymentRequirements,
    startedAt: number,
    call: Call,
  ): Promise<{
    record?: SettlementRecord;
    won: boolean;
    origin: SettlementOrigin;
    fallback?: Omit<Settled, "key">;
  }> => {
    const { key } = claimed;
    const operation = verified.transaction.operations[0] as Operation.InvokeHostFunction;
    const contractCall = { func: operation.func, auth: operation.auth ?? [] };
    // Stop waiting for a channel at the budget, or once the auth has (about) expired.
    const ledgersLeft = verified.expirationLedger - verified.currentLedger;
    const deadline = startedAt + Math.min(deps.budgetMs, ledgersLeft * ledgerMs);
    let result: SubmitResult | undefined;
    let uncertain: string | undefined;
    try {
      try {
        result = await deps.submitter.submit(contractCall, {
          checkSimulation: expectTransfer({
            asset: requirements.asset,
            from: verified.payer,
            to: requirements.payTo,
            amount: BigInt(requirements.amount),
          }),
          onSigned: async (hash, bounds) => {
            // After the budget answer nothing new is signed: the answer named the last hash, and
            // a rebuild's would land under another.
            if (call.budgetOver) throw new Error("the settle budget ran out");
            call.signing = hash;
            // Durable before the first send (AD-16); a final or missing record stops the send.
            // Only on this call's own claim: once reopened, the record is another call's (0073).
            if (!(await store.addHash(key, hash, now(), bounds, claimed.reopened)))
              throw new Error("the settlement record is final or missing");
            // The lease may have gone since the request came in, after a long body upload or
            // wait for a channel (0025 decision 22): another process may send on this channel.
            if (deps.held && !deps.held()) throw new Error("the channel lease was lost");
            // The budget answer may have gone out while the store wrote: it named the hash it
            // could read, so this one isn't sent.
            if (call.budgetOver) throw new Error("the settle budget ran out");
          },
          // A hint for debugging, never awaited: the send has happened, so a failed write changes
          // nothing (0019 decision 7). Not a record failure: no outage alarm, no sweep.
          onSent: (hash) =>
            void store.markAttempts(key, [{ hash, state: "sent" }], now()).catch((error: unknown) =>
              logger.warn("settlement_attempt_mark_failed", {
                network,
                settlementKey: key,
                transaction: hash,
                error,
              }),
            ),
          deadline,
          maxLedger: verified.expirationLedger,
        });
      } catch (error) {
        // A send that threw may have reached the network: keep the record open (0019 resolves it).
        // `sent: "yes"` is an accepted send or a refused one, so after an unexpected error it may
        // still land too; a classified error says the pool knows it won't.
        const errorReason = reasonFor(error);
        const attempts = attemptUpdates(attemptsOf(error), { error });
        const unknown = attemptsOf(error).filter((attempt) =>
          errorReason === SETTLE_REASONS.unexpected
            ? attempt.sent !== "no"
            : attempt.sent === "unknown",
        );
        if (unknown.length > 0) {
          uncertain = unknown.at(-1)!.hash;
          logger.warn("settlement_uncertain", {
            network,
            settlementKey: key,
            transaction: uncertain,
            error,
          });
          metrics.increment("settlement_uncertain_total");
          return {
            record: (await advance(key, { state: "pending", attempts })) ?? (await store.get(key)),
            won: false,
            origin: call.origin,
          };
        }
        if (errorReason === SETTLE_REASONS.unexpected) {
          logger.error("settlement_submit_failed", { network, settlementKey: key, error });
          metrics.increment("settlement_submit_failures_total");
        }
        // The answer is the same fixed reason, and the client needs a new payment.
        flagDrift(key, errorReason, "pool");
        return await finish(key, { state: "rejected", errorReason, attempts }, call.origin);
      }
      const fields = {
        channel: result.channel,
        ledger: result.ledger,
        feeCharged: result.feeCharged,
        attempts: attemptUpdates(result.attempts, result),
      };
      switch (result.status) {
        case "success":
          return await finish(key, { state: "success", ...fields }, call.origin);
        case "pending":
          // The pool keeps confirming; its `resolved` event finishes the record (0019).
          return {
            record: (await advance(key, { state: "pending", ...fields })) ?? (await store.get(key)),
            won: false,
            origin: call.origin,
          };
        default:
          return await finish(
            key,
            { state: result.status, errorReason: SETTLE_REASONS[result.status], ...fields },
            call.origin,
          );
      }
    } catch (error) {
      // A store failure while recording: the answer is the pool's result, or `pending` with the
      // hash of a send that may have reached the network. 0019 finishes the record.
      recordFailed(key, error);
      // Read back first: a success the store holds, written by this write after all or by a
      // sweep, is answered through `respond`, whose mark decides who gets it (0019 decision 32).
      const stored = await store.get(key).catch((readError: unknown) => {
        recordFailed(key, readError);
        return undefined;
      });
      if (result?.status === "success" && stored?.state === "success")
        return { record: stored, won: false, origin: call.origin };
      let fallback: Omit<Settled, "key"> | undefined;
      if (result?.status === "success" && answeredHere.has(key)) {
        // A repeat in this process is answering it from the store already.
        fallback = { response: alreadySettled(verified.payer, result.hash ?? "") };
      } else if (result) {
        // A success still carries the header (0031): the record as it would have been stored.
        // Without a stored record there is no `markSuccessAnswered` and no `onSuccess`. The
        // caller puts the key into `answeredHere` only when it sends this answer.
        const record: SettlementRecord | undefined =
          result.status === "success"
            ? {
                ...claimed,
                state: "success",
                hashes: result.hash ? [result.hash] : [],
                channel: result.channel,
                ledger: result.ledger,
                feeCharged: result.feeCharged,
                updatedAt: now(),
              }
            : undefined;
        fallback = { response: answerResult(result, verified.payer), record };
      } else if (uncertain) {
        fallback = {
          response: failure(SETTLE_REASONS.pending, verified.payer, undefined, uncertain),
        };
      }
      return { record: stored, won: false, origin: call.origin, fallback };
    }
  };

  const reads = new Map<SettlementKey, Promise<SettlementRecord | undefined>>();
  /**
   * The record after one poll interval. Repeats of one key share each read, so a thousand of
   * them cost one store read per interval. `undefined` if the read failed.
   */
  const nextRead = (key: SettlementKey) => {
    let read = reads.get(key);
    if (!read) {
      read = sleep(pollMs)
        .then(() => bounded(store.get(key), storeGraceMs))
        .catch((error: unknown) => {
          recordFailed(key, error);
          return undefined;
        })
        .finally(() => reads.delete(key));
      reads.set(key, read);
    }
    return read;
  };

  /**
   * A repeat call: the stored outcome, waiting a while for a record that isn't final. A record
   * with a hash waits up to `settleTimeoutMs`, counted from when this call first sees a hash, so
   * a repeat that waited for the signing still waits for the landing. One without can be signed
   * only until the first call's budget, counted from that call's start (before its checks): past
   * it the repeat ends the record itself ({@link endUnsigned}), so it answers `…_timeout` only for
   * what will never be sent. A repeat whose own budget ends before the first call's answers
   * `settlement_pending` with no hash and leaves the record open. If the store can't end it,
   * nothing is known, so the answer is `settlement_pending` with no hash: repeat the same payment.
   * Both waits end by this call's own budget (`startedAt`), and a repeat whose client left stops
   * waiting.
   */
  const replay = async (
    existing: SettlementRecord,
    fingerprint: string,
    signal: AbortSignal | undefined,
    startedAt: number,
  ): Promise<Settled> => {
    const { key } = existing;
    if (existing.fingerprint !== fingerprint) {
      // Counted before any check: a forged body can raise it.
      metrics.increment("settlement_nonce_reuse_total");
      // Never the outcome, but the hash, so a payment that landed can be reconciled on chain.
      return {
        key,
        replay: true,
        response: failure(
          SETTLE_REASONS.nonceUsed,
          existing.payer,
          "this payer's nonce was already used for a different payment",
          existing.hashes.at(-1) ?? "",
        ),
      };
    }
    let record = existing;
    const ownEnd = startedAt + deps.budgetMs;
    // The first call may sign until its own budget ends. A repeat that lost the claim began
    // before it, so its own budget can end first: it stops waiting then, but leaves the record to
    // the first call, which may still reserve or sign.
    const firstEnd = existing.createdAt + deps.budgetMs;
    const unsignedUntil = Math.min(firstEnd, ownEnd);
    let hashSeenAt: number | undefined;
    const until = () => {
      if (record.hashes.length === 0) return unsignedUntil;
      hashSeenAt ??= now();
      return Math.min(hashSeenAt + deps.settleTimeoutMs, ownEnd);
    };
    while (!isFinal(record) && now() < until() && !signal?.aborted) {
      record = (await nextRead(key)) ?? record;
    }
    if (!isFinal(record) && record.hashes.length === 0 && !signal?.aborted) {
      if (now() < firstEnd) {
        return {
          key,
          replay: true,
          response: failure(
            SETTLE_REASONS.pending,
            record.payer,
            "not signed yet: repeat the same payment",
          ),
        };
      }
      // Against the claim this repeat first read: one reopened since is another call's.
      const ended = await endUnsigned(key, existing.version);
      // The store didn't answer: the record may still be signed, so never "sign a new payment".
      // A claim reopened since is still being settled.
      if (!ended || (!isFinal(ended) && ended.hashes.length === 0)) {
        return {
          key,
          replay: true,
          response: failure(
            SETTLE_REASONS.pending,
            record.payer,
            ended
              ? "not signed yet: repeat the same payment"
              : "the settlement record could not be read: repeat the same payment",
          ),
        };
      }
      record = ended;
    }
    return respond(record, signal, { replay: true });
  };

  const settle = async (
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    signal: AbortSignal | undefined,
    validOnce: () => Promise<Validity | undefined>,
  ): Promise<Settled> => {
    const startedAt = now();
    const left = () => deps.budgetMs - (now() - startedAt);
    const fingerprint = fingerprintOf(payload, requirements);
    // A known settlement gets its stored outcome without the checks: once it has landed, its
    // nonce is used on chain and upstream's simulation fails, so a retry after
    // `settlement_pending` could never be answered. The fingerprint must still match (AD-6).
    // Before the claim, a store that fails or doesn't answer within the budget is a 500.
    const known = requirements.network === network ? keyOf(payload, network) : undefined;
    const existing = known && (await bounded(store.get(known), left()));
    // The identical payment, closed with nothing sent: it reopens if its auth entry can still land
    // and it passes the checks again, as a first payment would (0073 decisions 5, 13).
    const reopening = existing && reopenable(existing, fingerprint) ? existing : undefined;
    if (existing && !reopening) return replay(existing, fingerprint, signal, startedAt);
    if (reopening) {
      const valid = await validOnce();
      if (valid?.left === undefined || valid.left < SETTLE_MIN_VALIDITY_LEDGERS)
        return respond(reopening, signal, { replay: true });
    }
    // A record this call would reopen is left as it is until the reopen.
    const untouched = reopening && { key: reopening.key, replay: true };

    // Nothing is claimed yet, so a budget that runs out here records nothing: the same payment
    // may be sent again as it is.
    const unclaimed = () => ({
      ...untouched,
      response: failure(SETTLE_REASONS.timeout, undefined),
    });
    let checked: Awaited<ReturnType<Check>>;
    try {
      checked = await bounded(deps.check(payload, requirements), left());
    } catch (error) {
      if (error instanceof OutOfTimeError) return unclaimed();
      throw error;
    }
    const { response: verdict, verified } = checked;
    if (!verified) {
      flagDrift(undefined, verdict.invalidReason, "check");
      return {
        ...untouched,
        response: failure(
          verdict.invalidReason ?? SETTLE_REASONS.unexpected,
          verdict.payer,
          verdict.invalidMessage,
        ),
      };
    }
    const { payer, nonce } = verified;
    const key: SettlementKey = `${network}:${payer}:${nonce}`;
    if (left() <= 0) return unclaimed();
    // At least the store's grace: a claim cut off by a 0 ms bound may still land. A claim past
    // it is a 500, and the client's repeat finds the record.
    const reopened =
      reopening &&
      (await bounded(
        store.reopen(key, fingerprint, UNSENT_REASONS, startedAt),
        Math.max(left(), storeGraceMs),
      ));
    if (reopened) {
      logger.info("settlement_reopened", {
        network,
        settlementKey: key,
        errorReason: reopening.errorReason,
        reopened: reopened.reopened,
      });
      metrics.increment("settlement_reopened_total", { reason: reopening.errorReason ?? "" });
    }
    // A reopen that lost (another call reopened it first, or the record moved on) is a repeat.
    const claim = reopened
      ? { claimed: true as const, record: reopened }
      : await bounded(
          store.claim({
            key,
            network,
            payer,
            nonce,
            fingerprint,
            paymentPayload: payload,
            paymentRequirements: requirements,
            createdAt: startedAt,
          }),
          Math.max(left(), storeGraceMs),
        );
    if (!claim.claimed) return replay(claim.existing, fingerprint, signal, startedAt);

    const call: Call = { budgetOver: false, origin: "settle" };
    /**
     * The budget ran out (ADR 0011). From here nothing new is signed. A record with no hash ends
     * `rejected`, a signed one is `settlement_pending` with its hash, and a submission that is
     * already signed goes on. If the store doesn't answer, the answer is what this call knows.
     */
    const outOfBudget = async (hook?: Promise<unknown>): Promise<Settled> => {
      call.budgetOver = true;
      call.origin = "resolved";
      const record = await endUnsigned(key, claim.record.version, hook);
      const signed = record ? record.hashes.length > 0 : call.signing !== undefined;
      metrics.increment("settlement_budget_exhausted_total", { signed: String(signed) });
      if (record) return respond(record, signal);
      return {
        key,
        response: call.signing
          ? failure(SETTLE_REASONS.pending, payer, undefined, call.signing)
          : failure(SETTLE_REASONS.timeout, payer),
      };
    };

    // AD-18: spend budgets may refuse. A refusal ends the record without `onFinal` (hooks.ts). A
    // hook that doesn't answer within the budget ends it as the budget does, with `onFinal` once
    // the hook has settled, so a reservation it makes late is released.
    let verdictOfHook: BeforeSubmitResult;
    let hook: Promise<BeforeSubmitResult> | undefined;
    try {
      hook = deps.hooks.beforeSubmit({
        key,
        network,
        payer,
        payTo: requirements.payTo,
        asset: requirements.asset,
        amount: BigInt(requirements.amount),
        maxFeeStroops: deps.maxFeeStroops,
        paymentPayload: payload,
        paymentRequirements: requirements,
        reopened: claim.record.reopened,
        now: now(),
      });
      verdictOfHook = await bounded(hook, left());
    } catch (error) {
      if (error instanceof OutOfTimeError) return outOfBudget(hook);
      hookFailed("beforeSubmit", key, error);
      verdictOfHook = { allow: false, errorReason: SETTLE_REASONS.refused };
    }
    if (!verdictOfHook.allow) {
      // Nothing was submitted, so the refusal stands even if it can't be stored. The record then
      // stays `claimed` with no hash, and a repeat after the budget ends it with `…_timeout`.
      try {
        await bounded(
          advance(key, { state: "rejected", errorReason: verdictOfHook.errorReason }),
          Math.max(left(), storeGraceMs),
        );
      } catch (error) {
        recordFailed(key, error);
      }
      return { key, response: failure(verdictOfHook.errorReason, payer) };
    }

    // The checks and the hook used up the budget: nothing is submitted.
    if (left() <= 0) return outOfBudget();
    const submission = submit(claim.record, verified, requirements, startedAt, call);
    submissions.add(submission);
    const forget = () => void submissions.delete(submission);
    submission.then(forget, forget);
    const inTime = await within(submission, left());
    if (inTime) {
      const { record, won, origin, fallback } = inTime;
      if (fallback) {
        // Only a success this call sends is answered: a client that left marks nothing, as in
        // `respond`, so a repeat still gets it. One that is sent keeps a repeat in this process
        // from answering it too, until reconciliation marks it.
        if (fallback.record && !signal?.aborted) {
          answeredHere.add(key);
          unmarked.add(key);
        }
        return { key, ...fallback };
      }
      if (!record) return { key, response: failure(SETTLE_REASONS.unexpected, payer) };
      return respond(record, signal, {
        afterResponse:
          record.state === "success" && won ? () => onSuccess(record, origin) : undefined,
      });
    }
    // A signed submission goes on; a late success is cataloged with the origin its record got.
    void submission.then(({ record, won, origin }) => {
      if (record?.state === "success" && won) onSuccess(record, origin);
    });
    return outOfBudget();
  };

  // Every answer by outcome (0027): `success`, or the `errorReason`. A thrown error is the
  // route's 500.
  const settler: Settle = async (payload, requirements, signal) => {
    // One ledger read per call, shared by the reopen and the answer, so both decide alike.
    let valid: Promise<Validity | undefined> | undefined;
    const validOnce = () => (valid ??= validity(payload));
    const settled = await withRetry(
      await settle(payload, requirements, signal, validOnce),
      validOnce,
    );
    const { response } = settled;
    metrics.increment("settlement_outcomes_total", {
      reason: response.success ? "success" : (response.errorReason ?? SETTLE_REASONS.unexpected),
      replay: String(settled.replay ?? false),
    });
    return settled;
  };
  return Object.assign(settler, {
    drain: async () => void (await Promise.allSettled([...submissions])),
  });
}

/**
 * How long a store call may take once the budget is out, or while a repeat polls, by default.
 * The longest budget (80 s) plus this stays below the load balancer's 120 s (ADR 0011).
 */
const STORE_GRACE_MS = 1_000;

/**
 * The payload's auth expiration ledger, and how many ledgers it has left: unset when the latest
 * ledger couldn't be read in time.
 */
interface Validity {
  expiration: number;
  left?: number;
}

/**
 * How long reading the latest ledger may take for an unsent answer or a reopen. The longest
 * budget (80 s) plus the store's grace and this stays below the load balancer's 120 s.
 */
const LEDGER_READ_MS = 1_000;

/**
 * Whether a repeat with `fingerprint` may reopen `record` (0073 decision 13): the same payment,
 * closed `rejected` with one of {@link UNSENT_REASONS} and no hash, so nothing was ever sent.
 */
function reopenable(record: SettlementRecord, fingerprint: string): boolean {
  return (
    record.state === "rejected" &&
    record.fingerprint === fingerprint &&
    record.hashes.length === 0 &&
    UNSENT.has(record.errorReason ?? "")
  );
}

class OutOfTimeError extends Error {
  override readonly name = "OutOfTimeError";
}

/** The promise's value, or an {@link OutOfTimeError} if it doesn't settle within `ms`. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OutOfTimeError(`no answer within ${ms} ms`)),
      Math.max(0, ms),
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The promise's value, or `undefined` if it doesn't settle within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The fixed `errorReason` for each error `submit()` throws (AD-6). */
export function reasonFor(error: unknown): string {
  if (error instanceof SimulationCheckError) return SETTLE_REASONS.balanceChanges;
  if (error instanceof SimulationError) return SETTLE_REASONS.simulation;
  if (error instanceof FeeLimitError) return SETTLE_REASONS.fee;
  if (error instanceof LedgerBoundError) return SETTLE_REASONS.ledgerBound;
  if (error instanceof SignedHookError) return SETTLE_REASONS.recordWrite;
  if (error instanceof QueueTimeoutError) return SETTLE_REASONS.noChannelInTime;
  if (error instanceof NoChannelsError) return SETTLE_REASONS.noChannels;
  if (error instanceof ShutdownError) return SETTLE_REASONS.shuttingDown;
  if (error instanceof RpcTimeoutError || error instanceof RpcUnavailableError)
    return SETTLE_REASONS.rpcUnavailable;
  if (error instanceof SourceAccountAuthError) return SETTLE_REASONS.unsupportedCredential;
  return SETTLE_REASONS.unexpected;
}

/**
 * The settlement key a payload claims, read from its transaction alone: the `transfer`'s `from`
 * (what upstream names the payer) and that payer's nonce. `undefined` if it can't be read.
 */
export function keyOf(payload: PaymentPayload, network: StellarNetwork): SettlementKey | undefined {
  try {
    const transaction = new Transaction(
      (payload.payload as { transaction: string }).transaction,
      getNetworkPassphrase(network),
    );
    const operation = transaction.operations[0];
    if (operation?.type !== "invokeHostFunction") return undefined;
    const from: unknown = scValToNative(operation.func.invokeContract().args()[0]!);
    if (typeof from !== "string") return undefined;
    const nonce = payerNonce({ transaction, payer: from });
    return nonce === undefined ? undefined : `${network}:${from}:${nonce}`;
  } catch {
    return undefined;
  }
}

/** SHA-256 of the payload and requirements as canonical JSON (sorted keys), hex (AD-6). */
export function fingerprintOf(payload: PaymentPayload, requirements: PaymentRequirements): string {
  return createHash("sha256")
    .update(canonical({ paymentPayload: payload, paymentRequirements: requirements }))
    .digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The spec's balance-change check on the settlement's own simulation (AD-3): exactly one
 * `transfer` event, from the asset contract, of `amount` from the payer to `payTo`, and no other
 * contract event. It reads the events as upstream `verify()` reads its simulation's.
 */
export function expectTransfer(expected: {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
}): (sim: rpc.Api.SimulateTransactionSuccessResponse) => void {
  return (sim) => {
    const transfers: { asset: string; from: unknown; to: unknown; amount: unknown }[] = [];
    for (const diagnostic of sim.events ?? []) {
      const event = diagnostic.event();
      if (event.type().name !== "contract") continue;
      const topics = event.body().v0().topics();
      const contractId = event.contractId();
      if (
        topics.length < 3 ||
        topics[0]!.switch().name !== "scvSymbol" ||
        topics[0]!.sym().toString() !== "transfer" ||
        !contractId
      ) {
        throw new Error("the simulation emits a contract event other than a transfer");
      }
      transfers.push({
        asset: Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString(),
        from: scValToNative(topics[1]!),
        to: scValToNative(topics[2]!),
        amount: scValToNative(event.body().v0().data()),
      });
    }
    if (transfers.length !== 1) {
      throw new Error(`the simulation has ${transfers.length} transfers, not 1`);
    }
    const [transfer] = transfers;
    if (
      transfer!.asset !== expected.asset ||
      transfer!.from !== expected.from ||
      transfer!.to !== expected.to ||
      transfer!.amount !== expected.amount
    ) {
      throw new Error("the simulated transfer differs from the payment");
    }
  };
}
