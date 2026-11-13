import { Address, xdr } from "@stellar/stellar-sdk";
import type { FailureCause, SorobanRpc } from "@stellar-x402/signer-pool";
import type { Logger } from "../logger.js";

/**
 * `/verify`'s code, and `/settle`'s through its re-check: another transaction already used the
 * payer's nonce (0141). The payment may have settled there, or the payer spent the nonce on
 * another transfer; the chain tells which, so it is no advice to sign a new payment.
 */
export const NONCE_CONSUMED_REASON = "invalid_exact_stellar_payload_nonce_consumed_elsewhere";
/** The same for a settlement that was already claimed: its record ends with this code. */
export const NONCE_CONSUMED_SETTLE_REASON = "settle_exact_stellar_nonce_consumed_elsewhere";

/**
 * Whether our failed transaction failed because another transaction used the payer's nonce first.
 * The host then raises `Error(Auth, ExistingValue)` in the token's frame, when the token asks for
 * the payer's auth. In the payer's own frame the same error comes from the wallet's own nested
 * auth, not from a used nonce (0024).
 */
export function consumedElsewhere(failure: FailureCause | undefined, payer: string): boolean {
  return (
    failure?.error?.type === "sceAuth" &&
    failure.error.code === "scecExistingValue" &&
    failure.contract !== payer
  );
}

/** Whether the payer's nonce is used on chain; `false` too when it couldn't be read. */
export type IsNonceUsed = (payer: string, nonce: string) => Promise<boolean>;

/**
 * Reads the entry the host writes for a used nonce: a temporary entry of the payer's address,
 * kept until the auth entry expires. So while the payment could still settle, it says whether
 * the nonce is used. The RPC's own timeout and its failover to the next URL apply. A read that
 * still fails is logged and `false`: the payment is refused either way. Then a front-run keeps
 * the old reason and its advice to sign a new payment, which needs every RPC URL down in that
 * second.
 */
export function createNonceLookup(
  rpc: Pick<SorobanRpc, "getLedgerEntries">,
  network: string,
  logger: Pick<Logger, "warn">,
): IsNonceUsed {
  return async (payer, nonce) => {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(payer).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyNonce(
          new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce) }),
        ),
        durability: xdr.ContractDataDurability.temporary(),
      }),
    );
    try {
      const { entries } = await rpc.getLedgerEntries(key);
      return entries.length > 0;
    } catch (error) {
      logger.warn("nonce_lookup_failed", { network, error });
      return false;
    }
  };
}
