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
  SignedHookError,
  SimulationCheckError,
  SimulationError,
  attemptsOf,
  type ContractCall,
  type SubmitOptions,
  type SubmitResult,
} from "@stellar-x402/signer-pool";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getAddressCredentials, getNetworkPassphrase } from "@x402/stellar";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import {
  FINAL_SETTLEMENT_STATES,
  type SettlementKey,
  type SettlementRecord,
  type SettlementStore,
  type SettlementUpdate,
} from "../ports/index.js";
import type { SettlementHooks, SettlementOrigin } from "./hooks.js";
import type { Check, Verified } from "./verify.js";

/**
 * Every `errorReason` `/settle` sends besides upstream's verify reasons (AD-6). Two are upstream's
 * own settle codes for the same outcome.
 */
export const SETTLE_REASONS = {
  /** Sent, not final by the time bound (the RPC stopped answering) or the settle budget. */
  pending: "settlement_pending",
  /** Included in a ledger but failed (upstream's code). */
  failed: "settle_exact_stellar_transaction_failed",
  /** Refused by the network before inclusion, e.g. `txBadSeq` twice (upstream's code). */
  rejected: "settle_exact_stellar_transaction_submission_failed",
  /** Not included before its time bound or ledger bound. */
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
  /** No channel was free before the deadline. */
  noChannelInTime: "settle_exact_stellar_no_channel_in_time",
  /** Every channel is out of the pool. */
  noChannels: "settle_exact_stellar_no_channels",
  /** The before-submit hook threw. A refusal carries the hook's own reason. */
  refused: "settle_exact_stellar_refused",
  /** The payload doesn't carry exactly one auth entry for the payer, so it has no settlement key. */
  payerAuth: "invalid_exact_stellar_payload_payer_auth_entries",
  /** This payer's nonce was already used for a different payload or requirements. */
  nonceUsed: "settle_exact_stellar_nonce_already_used",
  /** The settle budget ran out before anything was signed. */
  timeout: "settle_exact_stellar_timeout",
  /** Anything else (upstream's code). */
  unexpected: "unexpected_settle_error",
} as const;

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
  /** How long a repeat call waits for a non-final record (AD-6). */
  settleTimeoutMs: number;
  /** How long one `/settle` call may take, the wait for a channel included (ADR 0011). */
  budgetMs: number;
  /** Estimated ledger close time, to turn the auth expiry into a deadline. */
  ledgerMs?: number;
  /** How often a repeat call re-reads a non-final record. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Settled {
  response: SettleResponse;
  /** The record behind a `success` answer, for the `EXTENSION-RESPONSES` header (AD-8). */
  record?: SettlementRecord;
  /**
   * Set when this call turned the record `success`: runs `onSuccess(record, "settle")`. The
   * route calls it once the response is sent.
   */
  afterResponse?: () => void;
}

export type Settle = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<Settled>;

const isFinal = (record: SettlementRecord) => FINAL_SETTLEMENT_STATES.includes(record.state);

/**
 * `/settle` for `exact` (AD-2, AD-3, AD-6): rerun the `/verify` checks, claim
 * `network:payer:nonce`, run `beforeSubmit`, and submit the client's `{func, auth}` through the
 * pool, bounded by the auth expiry. A repeat call gets the stored outcome, but only with the same
 * fingerprint. Every record write is a forward-only compare-and-set, so concurrent callers and a
 * late completion can't both win. Hooks never change the answer, and their errors are logged.
 */
export function createSettler(deps: SettlerDeps): Settle {
  const {
    network,
    store,
    logger,
    metrics,
    ledgerMs = 5_000,
    pollMs = 250,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;

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

  /** Runs a hook without letting it reach the caller (hooks.ts). */
  const runHook = (hook: "onFinal" | "onSuccess", run: () => Promise<void>) => {
    const failed = (error: unknown) => {
      logger.error("settlement_hook_failed", { hook, error });
      metrics.increment("settlement_hook_failures_total", { hook });
    };
    try {
      run().catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  const onSuccess = (record: SettlementRecord, origin: SettlementOrigin) =>
    runHook("onSuccess", () => deps.hooks.onSuccess(record, origin));

  /**
   * Moves a record forward from whatever state it is in now. `undefined` means another writer got
   * there first, or the record is already final.
   */
  const advance = async (key: SettlementKey, update: Omit<SettlementUpdate, "updatedAt">) => {
    for (let tries = 0; tries < 3; tries++) {
      const current = await store.get(key);
      if (!current || isFinal(current)) return undefined;
      const moved = await store.transition(key, current.state, { ...update, updatedAt: now() });
      if (moved) return moved;
    }
    return undefined;
  };

  /** {@link advance}, then `onFinal` once for the writer that made the record final. */
  const finish = async (key: SettlementKey, update: Omit<SettlementUpdate, "updatedAt">) => {
    const record = await advance(key, update);
    if (record && isFinal(record)) runHook("onFinal", () => deps.hooks.onFinal(record, "settle"));
    return { record: record ?? (await store.get(key)), won: record !== undefined };
  };

  /** Submits a claimed settlement and records the result. Never rejects. */
  const submit = async (
    record: SettlementRecord,
    verified: Verified,
    requirements: PaymentRequirements,
    startedAt: number,
  ): Promise<{ record?: SettlementRecord; won: boolean }> => {
    const { key } = record;
    const operation = verified.transaction.operations[0] as Operation.InvokeHostFunction;
    const call = { func: operation.func, auth: operation.auth ?? [] };
    // Stop waiting for a channel at the budget, or once the auth has (about) expired.
    const ledgersLeft = verified.expirationLedger - verified.currentLedger;
    const deadline = startedAt + Math.min(deps.budgetMs, ledgersLeft * ledgerMs);
    try {
      let result: SubmitResult;
      try {
        result = await deps.submitter.submit(call, {
          checkSimulation: expectTransfer({
            asset: requirements.asset,
            from: verified.payer,
            to: requirements.payTo,
            amount: BigInt(requirements.amount),
          }),
          onSigned: async (hash) => {
            // Durable before the first send (AD-16); a final or missing record stops the send.
            if (!(await store.addHash(key, hash, now())))
              throw new Error("the settlement record is final or missing");
          },
          deadline,
          maxLedger: verified.expirationLedger,
        });
      } catch (error) {
        // A send that threw may have reached the network: keep the record open (0019 resolves it).
        if (attemptsOf(error).some((attempt) => attempt.sent === "unknown")) {
          logger.warn("settlement_uncertain", { network, settlementKey: key, error });
          return {
            record: (await advance(key, { state: "pending" })) ?? (await store.get(key)),
            won: false,
          };
        }
        const errorReason = reasonFor(error);
        if (errorReason === SETTLE_REASONS.unexpected) {
          logger.error("settlement_submit_failed", { network, settlementKey: key, error });
        }
        return await finish(key, { state: "rejected", errorReason });
      }
      const fields = {
        channel: result.channel,
        ledger: result.ledger,
        feeCharged: result.feeCharged,
      };
      switch (result.status) {
        case "success":
          return await finish(key, { state: "success", ...fields });
        case "pending":
          // The pool keeps confirming; its `resolved` event finishes the record (0019).
          return {
            record: (await advance(key, { state: "pending", ...fields })) ?? (await store.get(key)),
            won: false,
          };
        default:
          return await finish(key, {
            state: result.status,
            errorReason: SETTLE_REASONS[result.status],
            ...fields,
          });
      }
    } catch (error) {
      // A store failure while recording: the answer is the record as last stored, if any.
      logger.error("settlement_record_failed", { network, settlementKey: key, error });
      return { record: await store.get(key).catch(() => undefined), won: false };
    }
  };

  /** A repeat call: the stored outcome, waiting a while for a record that isn't final. */
  const replay = async (existing: SettlementRecord, fingerprint: string): Promise<Settled> => {
    if (existing.fingerprint !== fingerprint) {
      metrics.increment("settle_nonce_reuse_total");
      return {
        response: failure(
          SETTLE_REASONS.nonceUsed,
          existing.payer,
          "this payer's nonce was already used for a different payment",
        ),
      };
    }
    let record = existing;
    const until = now() + deps.settleTimeoutMs;
    while (!isFinal(record) && now() < until) {
      await sleep(Math.min(pollMs, Math.max(0, until - now())));
      record = (await store.get(record.key)) ?? record;
    }
    return { response: answer(record), record: record.state === "success" ? record : undefined };
  };

  return async (payload, requirements) => {
    const startedAt = now();
    const fingerprint = fingerprintOf(payload, requirements);
    // A known settlement gets its stored outcome without the checks: once it has landed, its
    // nonce is used on chain and upstream's simulation fails, so a retry after
    // `settlement_pending` could never be answered. The fingerprint must still match (AD-6).
    const known = requirements.network === network ? keyOf(payload, network) : undefined;
    const existing = known && (await store.get(known));
    if (existing) return replay(existing, fingerprint);

    const { response: verdict, verified } = await deps.check(payload, requirements);
    if (!verified) {
      return {
        response: failure(
          verdict.invalidReason ?? SETTLE_REASONS.unexpected,
          verdict.payer,
          verdict.invalidMessage,
        ),
      };
    }
    const { payer } = verified;
    const nonce = payerNonce(verified);
    if (nonce === undefined) {
      return {
        response: failure(
          SETTLE_REASONS.payerAuth,
          payer,
          "the payload must carry exactly one auth entry for the payer",
        ),
      };
    }
    const key: SettlementKey = `${network}:${payer}:${nonce}`;
    const claim = await store.claim({
      key,
      network,
      payer,
      nonce,
      fingerprint,
      paymentPayload: payload,
      paymentRequirements: requirements,
      createdAt: startedAt,
    });
    if (!claim.claimed) return replay(claim.existing, fingerprint);

    // AD-18: spend budgets may refuse. A refusal ends the record without `onFinal` (hooks.ts).
    let verdictOfHook;
    try {
      verdictOfHook = await deps.hooks.beforeSubmit({
        key,
        network,
        payer,
        payTo: requirements.payTo,
        asset: requirements.asset,
        amount: BigInt(requirements.amount),
        maxFeeStroops: deps.maxFeeStroops,
        paymentPayload: payload,
        paymentRequirements: requirements,
        now: now(),
      });
    } catch (error) {
      logger.error("settlement_hook_failed", { hook: "beforeSubmit", error });
      metrics.increment("settlement_hook_failures_total", { hook: "beforeSubmit" });
      verdictOfHook = { allow: false as const, errorReason: SETTLE_REASONS.refused };
    }
    if (!verdictOfHook.allow) {
      await advance(key, { state: "rejected", errorReason: verdictOfHook.errorReason });
      return { response: failure(verdictOfHook.errorReason, payer) };
    }

    const submission = submit(claim.record, verified, requirements, startedAt);
    const left = deps.budgetMs - (now() - startedAt);
    const inTime = await within(submission, left);
    if (inTime) {
      const { record, won } = inTime;
      if (!record) return { response: failure(SETTLE_REASONS.unexpected, payer) };
      const success = record.state === "success";
      return {
        response: answer(record),
        record: success ? record : undefined,
        afterResponse: success && won ? () => onSuccess(record, "settle") : undefined,
      };
    }
    // The budget ran out (ADR 0011). The submission goes on; a late success is cataloged then.
    void submission.then(({ record, won }) => {
      if (record?.state === "success" && won) onSuccess(record, "resolved");
    });
    const current = await store.get(key);
    return { response: current ? answer(current) : failure(SETTLE_REASONS.timeout, payer) };
  };
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

/** The int64 nonce of the payer's one auth entry, as a decimal string (AD-6). */
export function payerNonce({
  transaction,
  payer,
}: Pick<Verified, "transaction" | "payer">): string | undefined {
  const nonces: string[] = [];
  for (const operation of transaction.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    for (const entry of operation.auth ?? []) {
      const credentials = getAddressCredentials(entry.credentials());
      if (credentials && Address.fromScAddress(credentials.address()).toString() === payer) {
        nonces.push(credentials.nonce().toString());
      }
    }
  }
  return nonces.length === 1 ? nonces[0] : undefined;
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
