/** Closed set of codes; a caller branches on `code`, never on the message. */
export type PaymentErrorCode =
  | "unsupported_payment"
  | "asset_not_allowed"
  | "over_price_limit"
  | "over_budget"
  | "payto_changed"
  | "price_raised"
  | "terms_changed"
  | "insufficient_funds"
  | "payer_trustline_missing"
  | "payto_trustline_missing"
  | "payment_failed"
  | "payment_rejected"
  | "payment_unknown";

/**
 * Whether money may have moved. `none`: nothing was signed or sent, and a counted amount went back
 * to the budget. `not_settled`: the payment was sent and the seller says it did not settle; it
 * still counts as spent, since the signed authorization stays valid until it expires. `unknown`:
 * the payment was sent and its outcome is not known; it counts as spent.
 */
export type Paid = "none" | "not_settled" | "unknown";

const PAID: Partial<Record<PaymentErrorCode, Paid>> = {
  payment_rejected: "not_settled",
  payment_unknown: "unknown",
};

/**
 * A payment that was refused or failed. `message` is this library's own text, safe to show an
 * agent; what a seller or another library wrote is in `cause` only. The two trustline codes carry
 * the `account` without the trustline and the `asset`, both in an address's shape.
 */
export class PaymentError extends Error {
  override readonly name = "PaymentError";
  readonly paid: Paid;
  readonly account?: string;
  readonly asset?: string;

  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    options: { cause?: unknown; account?: string; asset?: string } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.paid = PAID[code] ?? "none";
    this.account = options.account;
    this.asset = options.asset;
  }
}
