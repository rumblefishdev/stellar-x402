/**
 * What the facilitator answered at `/verify`, as an `onAfterVerify` hook gets it.
 *
 * - `none`: the payment is valid.
 * - `refused`: the facilitator refused it, with its `reason` and, when it gave one, its `message`.
 *   `sellerMustAct` is true for a refusal only the seller can fix: a `payTo` that can't receive the
 *   asset. Every buyer's payment is refused until then.
 */
export type VerifyRefusal =
  | { status: "none" }
  | { status: "refused"; reason: string; message?: string; sellerMustAct: boolean };

/**
 * The refusals that are the seller's to fix: `payTo` has no trustline to the classic asset, or
 * doesn't exist; a contract `payTo` has no balance of the token yet, and its first one costs more
 * than the facilitator pays. Each message says what to do.
 */
const SELLER_REASONS: ReadonlySet<string> = new Set([
  "invalid_exact_stellar_payto_trustline_missing",
  "invalid_exact_stellar_pay_to_balance_missing",
]);

/** A reason as facilitators write them; anything else is `unknown`. */
const REASON = /^[a-z0-9_]{1,80}$/;
/**
 * The longest message passed on. Our facilitator's two seller refusals were 329 and 332 characters
 * on testnet (0094).
 */
export const REFUSAL_MESSAGE_CHARS = 500;

/**
 * The refusal in a `/verify` answer, such as the `result` an `onAfterVerify` hook gets. Upstream's
 * resource server answers the buyer a 402 with the reason alone and logs nothing, and
 * `onVerifyFailure` doesn't run for a refusal, so this hook is the only place the seller sees it:
 *
 * ```ts
 * resourceServer.onAfterVerify(async ({ result }) => {
 *   const refusal = readVerifyRefusal(result);
 *   if (refusal.status === "refused" && refusal.sellerMustAct)
 *     console.warn(`payments to you are refused: ${refusal.message ?? refusal.reason}`);
 * });
 * ```
 *
 * The message is the facilitator's text: it comes back on one line, without control or invisible
 * formatting characters, and at most `REFUSAL_MESSAGE_CHARS` long, so it can go to a log as it is.
 */
export function readVerifyRefusal(result: {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
}): VerifyRefusal {
  if (result.isValid) return { status: "none" };
  const reason =
    typeof result.invalidReason === "string" && REASON.test(result.invalidReason)
      ? result.invalidReason
      : "unknown";
  const message = printable(result.invalidMessage);
  return {
    status: "refused",
    reason,
    ...(message ? { message } : {}),
    sellerMustAct: SELLER_REASONS.has(reason),
  };
}

/** One line of printable text: control and format characters become spaces, then it is cut. */
function printable(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return undefined;
  return line.length > REFUSAL_MESSAGE_CHARS
    ? `${line.slice(0, REFUSAL_MESSAGE_CHARS - 1)}…`
    : line;
}
