import { x402Client, type SchemeRegistration } from "@x402/core/client";
import {
  InsufficientBalanceError,
  STELLAR_ASSET_ADDRESS_REGEX,
  STELLAR_DESTINATION_ADDRESS_REGEX,
  TrustlineMissingError,
} from "@x402/stellar";
import { utcDay, type BudgetEntry, type BudgetStore } from "./budget.js";
import { PaymentError } from "./errors.js";

/** What one asset may cost, in its atomic units: 10000 is 0.001 USDC. */
export interface AssetLimits {
  /** The largest price one call may pay. */
  maxPerCall: bigint;
  /** The most one UTC day may spend, kept in `BuyerConfig.budget`. Without it, no daily budget. */
  daily?: bigint;
}

export interface BuyerConfig {
  /** Scheme clients holding the buyer's key, such as `ExactStellarScheme` for a network. */
  schemes: SchemeRegistration[];
  /** The buyer's public address, the one those schemes sign for; it keys the budget. */
  payer: string;
  /** The assets that may be paid in, by contract address; an offer in any other is refused. */
  assets: Record<string, AssetLimits>;
  /** Where the day's spending is kept. Required as soon as an asset has a `daily` budget. */
  budget?: BudgetStore;
  /** The clock that decides the day; tests set it. */
  now?: () => Date;
}

/**
 * The longest a seller may keep a signed payment valid: 300 s is the `@x402/express` default. A
 * longer one could be settled long after the caller got its answer.
 */
export const MAX_AUTHORIZATION_SECONDS = 300;

/** The offer the client was asked to sign; `countedIn` is where its amount was counted, if it was. */
export interface PaidOffer {
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
  countedIn?: BudgetEntry;
}

/** One call's client and what happened on it. */
export interface PaymentCall {
  client: x402Client;
  /** The offer chosen, once the client was asked to sign it. */
  paid(): PaidOffer | undefined;
  /** Why nothing was signed, when the client refused every offer or signing failed. */
  failure(): PaymentError | undefined;
  /** Returns the counted amount to the budget: for a payment that was never signed or sent. */
  giveBack(): Promise<void>;
}

/** A config that could not hold its limits is refused when the helper is made, not at a payment. */
export function checkConfig(config: BuyerConfig): void {
  for (const [asset, { maxPerCall, daily }] of Object.entries(config.assets)) {
    if (maxPerCall < 0n || (daily !== undefined && daily < 0n)) {
      throw new Error(`The limits of ${asset} must not be negative.`);
    }
    // A budget kept nowhere would start from zero with every process and hold nothing.
    if (daily !== undefined && !config.budget) {
      throw new Error(
        `${asset} has a daily budget and no store to keep it in: pass \`budget\`, such as ` +
          "memoryBudget() for one process.",
      );
    }
  }
}

/**
 * The error for a payment that could not be signed. `@x402/stellar` simulates before it signs and
 * names what the asset contract refused: a missing trustline, the payer's or the seller's, or a
 * balance too low. Any other failure, and a simulation it could not name, is `payment_failed`.
 */
function signingFailure(error: Error, payer: string, payTo: string | undefined): PaymentError {
  if (error instanceof InsufficientBalanceError) {
    return new PaymentError("insufficient_funds", "The payer does not hold enough of the asset.", {
      cause: error,
    });
  }
  // The account and the asset go into the message an agent may read, so only in an address's
  // shape: upstream takes them from the simulation, but another scheme could put any text there.
  if (
    error instanceof TrustlineMissingError &&
    STELLAR_DESTINATION_ADDRESS_REGEX.test(error.account) &&
    STELLAR_ASSET_ADDRESS_REGEX.test(error.asset)
  ) {
    const named = { cause: error, account: error.account, asset: error.asset };
    // The asset contract stops at its first failure, the payer's side first, so a payer without a
    // trustline says nothing about the seller's.
    if (error.account === payer) {
      return new PaymentError(
        "payer_trustline_missing",
        `The payer ${error.account} has no trustline to the asset ${error.asset} and must add one ` +
          "before it can pay. The seller's account was not checked. Nothing was sent.",
        named,
      );
    }
    if (error.account === payTo) {
      return new PaymentError(
        "payto_trustline_missing",
        `The seller's account ${error.account} has no trustline to the asset ${error.asset}, so it ` +
          "cannot be paid in it; only the seller can add one. Nothing was sent.",
        named,
      );
    }
  }
  return new PaymentError("payment_failed", "The payment could not be created.", { cause: error });
}

/**
 * A client for one call, with the limits on it. One client per call, so its hooks know which
 * payment is this call's: upstream's hooks cannot tell one call's from another's on a shared
 * client, and its refusals carry no code.
 */
export function startCall(config: BuyerConfig): PaymentCall {
  // Upstream's own spend controls are off: these limits are in atomic units per asset and name
  // why they refused.
  const client = x402Client.fromConfig({ schemes: config.schemes, spendControls: false });
  const now = config.now ?? (() => new Date());
  let refusal: PaymentError | undefined;
  let paid: PaidOffer | undefined;
  let signingError: Error | undefined;

  const giveBack = async () => {
    if (!paid?.countedIn || !config.budget) return;
    try {
      await config.budget.giveBack(paid.countedIn, paid.amount);
    } catch {
      // The amount stays counted for the day: too strict, never too loose.
    }
  };

  // Of the seller's offers, keep those in an allowed asset, at a price above zero, with a short
  // enough authorization and within the per-call limit; the library pays the first one left, and
  // the daily budget is counted when it is chosen.
  client.registerPolicy((_version, offers) => {
    const allowed = offers.filter((offer) => Object.hasOwn(config.assets, offer.asset));
    // A zero or negative price would be counted before the library refuses to sign it, and a
    // negative count raises the day's budget until it is given back.
    const priced = allowed.filter((offer) => /^[1-9][0-9]*$/.test(offer.amount));
    const shortLived = priced.filter(
      (offer) => offer.maxTimeoutSeconds <= MAX_AUTHORIZATION_SECONDS,
    );
    const affordable = shortLived.filter(
      (offer) => BigInt(offer.amount) <= config.assets[offer.asset]!.maxPerCall,
    );
    if (allowed.length === 0) {
      refusal = new PaymentError("asset_not_allowed", "The seller asks for an asset not allowed.");
    } else if (priced.length === 0) {
      refusal = new PaymentError(
        "unsupported_payment",
        "The seller's price is not a whole number of atomic units above zero.",
      );
    } else if (shortLived.length === 0) {
      refusal = new PaymentError(
        "unsupported_payment",
        `The seller wants the payment valid for more than ${MAX_AUTHORIZATION_SECONDS} s.`,
      );
    } else if (affordable.length === 0) {
      refusal = new PaymentError("over_price_limit", "The price is over the per-call limit.");
    }
    return affordable;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements: offer }) => {
    const amount = BigInt(offer.amount);
    const daily = config.assets[offer.asset]!.daily;
    let countedIn: BudgetEntry | undefined;
    if (daily !== undefined && config.budget) {
      // The day's spending is read and the amount counted in one step, so callers paying at the
      // same moment never pass the day together. Once signed the amount is never given back, so a
      // seller cannot return it to the budget by claiming the payment failed.
      countedIn = { day: utcDay(now()), payer: config.payer, asset: offer.asset };
      let counted = false;
      try {
        counted = await config.budget.count(countedIn, amount, daily);
      } catch (error) {
        // How much is left today is unknown: pay nothing.
        refusal = new PaymentError(
          "payment_failed",
          "The budget store cannot be read or written, so nothing is paid.",
          { cause: error },
        );
      }
      if (!counted) {
        refusal ??= new PaymentError("over_budget", "The payment would exceed the daily budget.");
        return { abort: true, reason: refusal.code };
      }
    }
    paid = { network: offer.network, asset: offer.asset, payTo: offer.payTo, amount, countedIn };
  });
  // Nothing was sent: signing failed (a payer without the trustline or the funds fails here, in
  // simulation), so the amount goes back to the budget.
  client.onPaymentCreationFailure(async ({ error }) => {
    signingError = error;
    await giveBack();
  });

  return {
    client,
    paid: () => paid,
    failure: () =>
      refusal ?? (signingError && signingFailure(signingError, config.payer, paid?.payTo)),
    giveBack,
  };
}
