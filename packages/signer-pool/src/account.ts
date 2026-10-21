import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "./types.js";

/** The RPC answered that the account does not exist: `getLedgerEntries` returned no entry. */
export class AccountNotFoundError extends Error {
  override readonly name = "AccountNotFoundError";
}

/**
 * Reads an account entry. Only an answer with no entry is {@link AccountNotFoundError}; a failed
 * call (an error status, a refused connection, a timeout) throws its own error. `rpc.Server`'s
 * `getAccountEntry` and `getAccount` turn every failure into "Account not found", so the pool
 * never calls them.
 */
export async function readAccountEntry(
  rpc: Pick<SorobanRpc, "getLedgerEntries">,
  address: string,
): Promise<xdr.AccountEntry> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }),
  );
  const { entries } = await rpc.getLedgerEntries(key);
  const entry = entries[0];
  if (!entry) throw new AccountNotFoundError(`Account not found: ${address}`);
  return entry.val.account();
}
