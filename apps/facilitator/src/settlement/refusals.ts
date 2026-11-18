import type { StellarNetwork } from "@stellar-x402/config";
import type { VerifyResponse } from "@x402/core/types";
import type { Logger } from "../logger.js";
import type { SettlementStore } from "../ports/index.js";
import { UNSENT_REASONS } from "./reasons.js";
import { fingerprintOf, identityOf, type PayloadIdentity } from "./settle.js";
import type { Verify } from "./verify.js";

/**
 * How long one store call of `/verify` may take (0086). `/verify` has no budget of its own; past
 * this it answers 503, as for an RPC that gave no verdict.
 */
export const VERIFY_STORE_TIMEOUT_MS = 2_000;

/**
 * The settlement store didn't answer `/verify` (0086): it failed or ran past
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
 * Wraps the checks only: a breaker's refusal (`verifyWithBreakers`, outside) isn't recorded.
 */
export function verifyWithRefusals(verify: Verify, deps: RefusalDeps): Verify {
  const { network, store, logger, now = Date.now, storeTimeoutMs = VERIFY_STORE_TIMEOUT_MS } = deps;
  const stored = async <T>(op: string, call: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StoreUnavailableError(`settlement store ${op}: no answer in time`)),
        storeTimeoutMs,
      );
    });
    try {
      return await Promise.race([call(), timeout]);
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw error;
      throw new StoreUnavailableError(`settlement store ${op} failed`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };

  return async (payload, requirements, trace) => {
    const identity = requirements.network === network ? identityOf(payload, network) : undefined;
    if (!identity) return verify(payload, requirements, trace);
    const fingerprint = fingerprintOf(payload, requirements);
    const existing = await stored("get", () => store.get(identity.key));
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
        },
        UNSENT_REASONS,
        at,
      ),
    );
    // Another record answers for the key (one being settled, or another payload's): the refusal
    // is this call's alone, as before 0086.
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
