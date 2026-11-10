import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, Networks, StrKey, xdr } from "@stellar/stellar-sdk";

/** An account as the stub serves it: its signers (each at weight 1) and its master key weight. */
export interface StubAccount {
  signers: string[];
  masterWeight: number;
  /** Stroops; 1.5 XLM by default. */
  balance?: bigint;
}

/** A channel set up as AD-12 requires: master key weight 0, the facilitator its only signer. */
export const hardened = (facilitator: string): StubAccount => ({
  signers: [facilitator],
  masterWeight: 0,
});

/**
 * A Stellar RPC over HTTP for `main()`, which builds its own RPC from `RPC_URLS`: it answers
 * `getNetwork` with `passphrase`, `getLedgerEntries` for `accounts` (any other account doesn't
 * exist), and every other method with a 503. `reads` lists each account read, in order.
 */
export async function rpcStub(
  accounts: Record<string, StubAccount>,
  passphrase: string = Networks.TESTNET,
): Promise<{ url: string; reads: string[]; close(): Promise<void> }> {
  const reads: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: { keys: string[] };
      };
      res.setHeader("content-type", "application/json");
      if (method === "getNetwork") {
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id, result: { passphrase, protocolVersion: 23 } }),
        );
        return;
      }
      if (method !== "getLedgerEntries") {
        res.writeHead(503).end();
        return;
      }
      for (const key of params.keys) reads.push(accountOf(key));
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: ledgerEntries(params.keys, accounts) }));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reads,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A `getLedgerEntries` result for these keys: an entry for each of `accounts`, none for others. */
export function ledgerEntries(keys: string[], accounts: Record<string, StubAccount>) {
  const entries = keys.flatMap((key) => {
    const accountId = xdr.LedgerKey.fromXDR(key, "base64").account().accountId();
    const account = accounts[accountOf(key)];
    if (!account) return [];
    const data = xdr.LedgerEntryData.account(accountEntry(accountId, account));
    return [{ key, xdr: data.toXDR("base64"), lastModifiedLedgerSeq: 1 }];
  });
  return { entries, latestLedger: 100 };
}

/** The address of an account's ledger key, in base64 XDR. */
function accountOf(key: string): string {
  const accountId = xdr.LedgerKey.fromXDR(key, "base64").account().accountId();
  return StrKey.encodeEd25519PublicKey(accountId.ed25519());
}

/** The ledger's entry for an account with these signers, master key weight and balance. */
export function accountEntry(accountId: xdr.PublicKey, account: StubAccount): xdr.AccountEntry {
  return new xdr.AccountEntry({
    accountId,
    balance: xdr.Int64.fromString(String(account.balance ?? 15_000_000n)),
    seqNum: xdr.Int64.fromString("1"),
    numSubEntries: account.signers.length,
    inflationDest: null,
    flags: 0,
    homeDomain: "",
    // [master weight, low, medium, high]
    thresholds: Buffer.from([account.masterWeight, 0, 0, 0]),
    signers: account.signers.map(
      (key) =>
        new xdr.Signer({
          key: xdr.SignerKey.signerKeyTypeEd25519(Keypair.fromPublicKey(key).rawPublicKey()),
          weight: 1,
        }),
    ),
    ext: new xdr.AccountEntryExt(0),
  });
}
