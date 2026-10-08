import type { StellarNetwork } from "@stellar-x402/config";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
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
   * treated the same way.
   */
  | { allow: false; errorReason: string };

/** Where a record turned final: inline in `/settle`, or later (`resolved` event, startup re-check). */
export type SettlementOrigin = "settle" | "resolved";

/** The `EXTENSION-RESPONSES` header value of a settle response (AD-8). */
export interface ExtensionResponses {
  bazaar: { status: "processing" | "rejected"; reason?: string };
}

/**
 * Extension points of the settlement module, wired in the composition root. Payments calls them;
 * the other lanes implement them (spend budgets in 0024, cataloging in 0031).
 */
export interface SettlementHooks {
  /** Runs after the claim and before `submit()` (AD-18); may refuse the settlement. */
  beforeSubmit(context: BeforeSubmitContext): Promise<BeforeSubmitResult>;
  /**
   * Runs once when a record turns final, in any final state, after `beforeSubmit` allowed it:
   * settles or releases the spend reservation and feeds the breakers (AD-18). Its errors never
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
   * `resolved` event or the startup re-check finalizes it. Its result and errors never reach the
   * caller; the settlement module logs and counts them.
   */
  onSuccess(record: SettlementRecord, origin: SettlementOrigin): Promise<void>;
}
