import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";

export { FakeRpc, accountEntry } from "../src/testing.js";

export const facilitator = Keypair.random();
export const channelKeys = [Keypair.random(), Keypair.random(), Keypair.random()];
export const channels = channelKeys.map((k) => k.publicKey());

/** A `getLedgerEntries` answer holding `entry`, or no entry. */
export function ledgerEntries(entry?: xdr.AccountEntry): rpc.Api.GetLedgerEntriesResponse {
  const entries = entry ? [{ val: xdr.LedgerEntryData.account(entry) }] : [];
  return { entries, latestLedger: 1 } as unknown as rpc.Api.GetLedgerEntriesResponse;
}
