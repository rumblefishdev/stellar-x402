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
  /** Nothing is submitted; `/settle` answers `success: false` with this x402 `errorReason`. */
  | { allow: false; errorReason: string };

/** Where a record turned final: inline in `/settle`, or later (`resolved` event, startup re-check). */
export type SettlementOrigin = "settle" | "resolved";

/**
 * Extension points of the settlement module, wired in the composition root. Payments calls them;
 * the other lanes implement them (spend budgets in 0024, cataloging in 0031).
 */
export interface SettlementHooks {
  /** Runs after the claim and before `submit()` (AD-18); may refuse the settlement. */
  beforeSubmit(context: BeforeSubmitContext): Promise<BeforeSubmitResult>;
  /**
   * Runs once when a record turns final, in any final state, after `beforeSubmit` allowed it:
   * settles or releases the spend reservation and feeds the breakers (AD-18).
   */
  onFinal(record: SettlementRecord, origin: SettlementOrigin): Promise<void>;
  /**
   * Runs once when a record turns `success` (AD-8). Must return synchronously and never throw;
   * slow work such as the catalog write is started fire-and-forget. With origin `settle` the
   * result becomes the `EXTENSION-RESPONSES` header of the settle response; otherwise it is
   * ignored. It never changes the response body or status.
   */
  onSuccess(
    record: SettlementRecord,
    origin: SettlementOrigin,
  ): Record<string, unknown> | undefined;
}
