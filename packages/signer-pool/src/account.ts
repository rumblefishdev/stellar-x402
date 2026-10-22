import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "./types.js";

/**
 * Reads an account entry, or `undefined` when the RPC answered that the account does not exist
 * (`getLedgerEntries` returned no entry). A failed call (an error status, a refused connection, a
 * timeout, a JSON-RPC error) throws an error that says so. `rpc.Server`'s `getAccountEntry` and
 * `getAccount` turn every failure into "Account not found", which would read an RPC outage as a
 * missing channel.
 */
export async function readAccountEntry(
  rpc: Pick<SorobanRpc, "getLedgerEntries">,
  address: string,
): Promise<xdr.AccountEntry | undefined> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrPublicKey() }),
  );
  let entries;
  try {
    ({ entries } = await rpc.getLedgerEntries(key));
  } catch (error) {
    if (error instanceof Error) throw error;
    // `rpc.Server` throws a JSON-RPC error answer as the plain `{ code, message }` object.
    throw new Error(`RPC error: ${JSON.stringify(error)}`, { cause: error });
  }
  return entries[0]?.val.account();
}
