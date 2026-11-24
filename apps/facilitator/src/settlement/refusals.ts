import type { StellarNetwork } from "@stellar-x402/config";
import type { VerifyResponse } from "@x402/core/types";
import type { Logger } from "../logger.js";
import type { SettlementStore } from "../ports/index.js";
import { UNSENT_REASONS } from "./reasons.js";
import { isFinalRecord } from "./records.js";
import {
  LEDGER_READ_MS,
  OutOfTimeError,
  REFUSAL_HORIZON_LEDGERS,
  bounded,
  fingerprintOf,
  identityOf,
  type PayloadIdentity,
} from "./settle.js";
import type { Verify } from "./verify.js";

/**
 * How long one store call of `/verify` may take (0086). `/verify` has no budget of its own; past
 * this it answers 503, as for an RPC that gave no verdict.
 */
export const VERIFY_STORE_TIMEOUT_MS = 2_000;

/**
 * The settlement store didn't record `/verify`'s refusal (0086): it failed or ran past
 * {@link VERIFY_STORE_TIMEOUT_MS}. No verdict, so the route answers 503 and the seller sends the
 * same payment again: a refusal that wasn't recorded would invite a second signature.
 */
export class StoreUnavailableError extends Error {
  override readonly name = "StoreUnavailableError";
}

export interface RefusalDeps {
  network: StellarNetwork;
  store: Pick<SettlementStore, "get" | "refuse">;
  logger: Logger;
  /**
   * The network's latest ledger, read only after the checks refused a payload with an expiration
   * ledger, to keep a refusal too far ahead out of the store (0156).
   */
  latestLedger: () => Promise<number>;
  now?: () => number;
  storeTimeoutMs?: number;
}

/**
 * `/verify` with its refusals recorded (0086). A payment the checks refused can pass later (fees
 * drop, the payer tops up or adds a trustline), and by then its seller may have asked the payer to
 * sign another one; if both settled, the payer would pay twice. So a refusal of a payload with a
 * settlement key is stored as a `refused` record, which `/settle` then answers from, and a
 * repeat of the same payment gets the stored refusal here without the checks. The answer says the
 * payment won't settle here and, from its auth entry's expiration ledger, when a new one is safe.
 * A lookup the store doesn't answer runs the checks, as before 0086: the lookup only saves their
 * RPC calls, and `/settle` answers from the record itself. Wraps the checks only: a breaker's
 * refusal (`verifyWithBreakers`, outside) isn't recorded.
 */
export function verifyWithRefusals(verify: Verify, deps: RefusalDeps): Verify {
  const {
    network,
    store,
    logger,
    latestLedger,
    now = Date.now,
    storeTimeoutMs = VERIFY_STORE_TIMEOUT_MS,
  } = deps;
  /**
   * How many ledgers the auth entry has left, or `undefined` when the ledger couldn't be read in
   * time: then the refusal is recorded, as before 0156, since a missed record risks a double
   * payment and a row only costs disk.
   */
  const ledgersLeft = async (expiration: number): Promise<number | undefined> => {
    try {
      return expiration - (await bounded(latestLedger(), LEDGER_READ_MS));
    } catch (error) {
      logger.warn("latest_ledger_failed", { network, error });
      return undefined;
    }
  };
  const stored = async <T>(op: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await bounded(call(), storeTimeoutMs);
    } catch (error) {
      const what = error instanceof OutOfTimeError ? "no answer in time" : "failed";
      throw new StoreUnavailableError(`settlement store ${op}: ${what}`, { cause: error });
    }
  };

  return async (payload, requirements, trace) => {
    const identity = requirements.network === network ? identityOf(payload, network) : undefined;
    if (!identity) return verify(payload, requirements, trace);
    const fingerprint = fingerprintOf(payload, requirements);
    const existing = await stored("get", () => store.get(identity.key)).catch((error: unknown) => {
      logger.warn("verify_store_lookup_failed", { network, settlementKey: identity.key, error });
      return undefined;
    });
    if (existing?.state === "refused" && existing.fingerprint === fingerprint) {
      return refused(
        {
          isValid: false,
          invalidReason: existing.errorReason,
          ...(existing.errorMessage !== undefined && { invalidMessage: existing.errorMessage }),
          payer: existing.payer,
          ...(existing.errorDetail !== undefined && { extra: { reason: existing.errorDetail } }),
        },
        identity,
      );
    }
    const response = await verify(payload, requirements, trace);
    if (response.isValid || response.invalidReason === undefined) return response;
    // A record that already answers for the key adds no row (as `/settle`'s reopen), so it
    // isn't held to the horizon: `refuse` answers from it as before (0156).
    if (existing === undefined && identity.expiration !== undefined) {
      const left = await ledgersLeft(identity.expiration);
      if (left !== undefined && left > REFUSAL_HORIZON_LEDGERS) {
        logger.info("settlement_refusal_unrecorded", {
          network,
          settlementKey: identity.key,
          expirationLedger: identity.expiration,
          ledgersLeft: left,
        });
        return unrecorded(response, identity.expiration);
      }
    }
    const at = now();
    const record = await stored("refuse", () =>
      store.refuse(
        {
          key: identity.key,
          network,
          payer: identity.payer,
          nonce: identity.nonce,
          fingerprint,
          paymentPayload: payload,
          paymentRequirements: requirements,
          createdAt: at,
        },
        {
          errorReason: response.invalidReason!,
          ...(response.invalidMessage !== undefined && { errorMessage: response.invalidMessage }),
          ...(typeof response.extra?.reason === "string" && { errorDetail: response.extra.reason }),
          ...(identity.expiration !== undefined && { expirationLedger: identity.expiration }),
        },
        UNSENT_REASONS,
        at,
      ),
    );
    // The same payment is being settled: "fee too high" alone would invite a second signature.
    if (record.fingerprint === fingerprint && !isFinalRecord(record)) return underWay(response);
    // Another record answers for the key (one that ended, or another payload's): the refusal is
    // this call's alone, as before 0086.
    if (record.state !== "refused" || record.fingerprint !== fingerprint) return response;
    // A new refusal has version 0; a record it moved from `rejected`, more.
    if (record.version > 0) {
      logger.info("settlement_refused_reopen", {
        network,
        settlementKey: record.key,
        errorReason: record.errorReason,
      });
    }
    return refused(response, identity);
  };
}

/**
 * The refusal while a settlement of the same payment is under way (0086, review of #205): its
 * outcome is `/settle`'s to answer, from the record, so no new signature until then.
 */
function underWay(response: VerifyResponse): VerifyResponse {
  const advice =
    "a settlement of this payment is under way: send this payment to /settle for its outcome " +
    "before signing a new one";
  return {
    ...response,
    invalidMessage: response.invalidMessage ? `${advice}; ${response.invalidMessage}` : advice,
  };
}

/**
 * A refusal past {@link REFUSAL_HORIZON_LEDGERS} (0156): no record, so the same payment may still
 * settle, here or elsewhere, until its expiration ledger; a new signature is safe only after it.
 */
function unrecorded(response: VerifyResponse, expiration: number): VerifyResponse {
  const advice =
    `this payment may still settle until ledger ${expiration}: sign a new payment once that ` +
    `ledger has closed`;
  return {
    ...response,
    invalidMessage: response.invalidMessage ? `${advice}; ${response.invalidMessage}` : advice,
    extra: { ...response.extra, expirationLedger: expiration },
  };
}

/**
 * The refusal with what to do next (0086, as `/settle`'s "ended" answer): the payment never
 * settles here, but whoever holds it may still land its auth entry elsewhere until its
 * expiration ledger, so a new signature is safe only once that ledger has closed.
 */
function refused(response: VerifyResponse, identity: PayloadIdentity): VerifyResponse {
  const { expiration } = identity;
  const advice =
    expiration === undefined
      ? "this payment will not settle here"
      : `this payment will not settle here, but its auth entry may still land in ledger ` +
        `${expiration}: sign a new payment once that ledger has closed`;
  return {
    ...response,
    invalidMessage: response.invalidMessage ? `${advice}; ${response.invalidMessage}` : advice,
    ...(expiration !== undefined && {
      extra: { ...response.extra, expirationLedger: expiration },
    }),
  };
}
