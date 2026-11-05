import type { FailureCause } from "@stellar-x402/signer-pool";
import type { AssetKind, AssetTier } from "./asset-kinds.js";

/** Who a failed settlement is charged to: a breaker only ever hits one of these. */
export type Fault = "payer" | "payTo" | "asset" | "ours";

const RESOURCE_OPCODES = new Set([
  "invokeHostFunctionResourceLimitExceeded",
  "invokeHostFunctionInsufficientRefundableFee",
]);

/**
 * Decides whose fault an included, failed settlement is, first matching rule wins; none, when
 * nobody's fault can be told. A SAC's code is the host's, so it is never the asset's fault;
 * `payTo` is named only when a known asset's SAC error says the recipient is the problem, never as
 * a default, so nobody can trip a seller's breaker by paying them with a failing token.
 */
export function attribute(
  failure: FailureCause | undefined,
  ctx: { kind: AssetKind; tier: AssetTier; payer: string; payTo: string; asset: string },
): Fault[] {
  const { kind, tier, payer, payTo, asset } = ctx;
  const opCode = failure?.opCode;
  const error = failure?.error;
  const fromAsset = failure?.contract === asset;
  // Before the reused-nonce rule on purpose: a front-run never names the payer. The host checks
  // the nonce when the token calls `require_auth`, before a C-account's `__check_auth` runs, so
  // the error names the token (shown on testnet, 0024's `front-run-testnet.json`). In the payer's
  // own frame it can only be the wallet's own nested auth, its own fault like any other there.
  if (failure?.contract === payer) return ["payer"];
  // The payment's nonce was already used: whoever holds the payload (the seller, say) submitted
  // it first. The payer signed one payment and the asset did nothing wrong, so nobody is charged.
  if (error?.type === "sceAuth" && error.code === "scecExistingValue") return [];
  if (error?.type === "sceAuth") return ["payer"];
  if (kind === "sac" && fromAsset && error?.type === "sceContract") {
    const code = error.code;
    if (code === "5" || code === "9" || code === "10") return ["payer"];
    // `data` is every address in the event, unordered. Blame payTo only when the event names it
    // and not the payer: a payer scope only hurts its owner, a payTo breaker would hurt a seller.
    // Only for a known asset: anyone can wrap a classic asset they issue and deauthorize payTo.
    if (code === "11" || code === "13") {
      const data = failure.data ?? [];
      const recipient = tier === "known" && data.includes(payTo) && !data.includes(payer);
      return recipient ? ["payTo"] : ["payer"];
    }
    return ["payer"];
  }
  if (kind === "wasm" && (fromAsset || (opCode !== undefined && RESOURCE_OPCODES.has(opCode)))) {
    return ["asset", "payer"];
  }
  if (kind === "sac" && opCode !== undefined && RESOURCE_OPCODES.has(opCode)) {
    // A C-account payer's `__check_auth` ran in the transaction and may have used the resources;
    // a G-account's or the SAC's own use is what the simulation priced, so a miss is ours.
    return payer.startsWith("C") ? ["payer"] : ["ours"];
  }
  if (kind === "sac" && opCode === "invokeHostFunctionEntryArchived") return ["ours"];
  return kind === "wasm" ? ["payer", "asset"] : ["payer"];
}
