import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ExtensionResponses } from "@stellar-x402/bazaar";
import type { SettlementKey, SettlementRecord } from "../ports/index.js";

/** A verified, claimed settlement about to be submitted. */
export interface BeforeSubmitContext {
  key: SettlementKey;
  network: StellarNetwork;
  payer: string;
  payTo: string;
  /** Token contract address. */
  asset: string;
  /** Token base units. */
  amount: bigint;
  /** Most the facilitator can pay in fees for this settlement (`maxFeeStroops`). */
  maxFeeStroops: bigint;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  now: number;
}

export type BeforeSubmitResult =
  | { allow: true }
  /**
   * Nothing is submitted: the record moves `claimed → rejected` with this x402 `errorReason`,
   * `/settle` answers `success: false`, and `onFinal` is not called. A hook that throws is
   * treated the same way, with `settle_exact_stellar_refused`. If the refusal can't be stored, the
   * record stays `claimed`: a repeat past the budget ends it with `…_timeout`, and then `onFinal`
   * runs (`settle`), so a release must tolerate a reservation that was never made.
   */
  | { allow: false; errorReason: string };

/** Where a record turned final: inline in `/settle`, or later (`resolved` event, startup re-check). */
export type SettlementOrigin = "settle" | "resolved";

/** The `EXTENSION-RESPONSES` header value of a settle response (AD-8), as `packages/bazaar` builds it. */
export type { ExtensionResponses } from "@stellar-x402/bazaar";

/**
 * Extension points of the settlement module, wired in the composition root. Payments calls them;
 * the other lanes implement them (spend budgets in 0024, cataloging in 0031).
 */
export interface SettlementHooks {
  /**
   * Runs after the claim and before `submit()` (AD-18); may refuse the settlement. It must answer
   * within what is left of the settle budget: past it, the record ends as the budget does
   * (`…_timeout`), whatever the hook answers later, and `onFinal` runs once the hook has settled,
   * so a reservation it makes late is released.
   */
  beforeSubmit(context: BeforeSubmitContext): Promise<BeforeSubmitResult>;
  /**
   * Runs once when a record turns final, in any final state, after `beforeSubmit` allowed it or
   * didn't answer within the budget: settles or releases the spend reservation, which may then
   * not exist, and feeds the breakers (AD-18). Its errors never
   * reach the caller and never change the settle outcome; `/settle` doesn't wait for it. The
   * settlement module logs and counts them.
   */
  onFinal(record: SettlementRecord, origin: SettlementOrigin): Promise<void>;
  /**
   * Pure and synchronous: the bazaar validation result for a `success` record settled inline,
   * computed before the response. `/settle` sends it as the `EXTENSION-RESPONSES` header; it
   * never changes the response body or status. `undefined` when the payload has no
   * `extensions.bazaar`.
   */
  extensionResponses(record: SettlementRecord): ExtensionResponses | undefined;
  /**
   * Runs once when a record turns `success` (AD-8): after the settle response is sent, or when a
   * `resolved` event, the startup re-check or a submission past the settle budget finalizes it
   * (`resolved`, the same origin `onFinal` gets). Its result and errors never reach the
   * caller; the settlement module logs and counts them.
   */
  onSuccess(record: SettlementRecord, origin: SettlementOrigin): Promise<void>;
}
